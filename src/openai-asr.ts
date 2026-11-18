import OpenAI from "openai";
import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import { containsChineseCharacters, convertChineseOutput, isChineseLanguage } from "./chinese.js";
import { describeError, writeLog } from "./log.js";
import {
  asrEndpointStyle,
  type ChineseOutput,
  type RemoteBackendSettings,
} from "./settings.js";
import type {
  DictationStream,
  TranscriptionOptions,
} from "./transcription.js";

type OpenAIAsrSettings = RemoteBackendSettings;

export type AsrRequest = {
  /** The whole recording as 16-bit mono WAV bytes. */
  wav: Buffer;
};

/** Uploads the recording and returns the transcript text. Injectable for tests. */
export type AsrTransport = (
  request: AsrRequest,
  signal?: AbortSignal,
) => Promise<string>;

const SAMPLE_RATE = CAPTURE_SAMPLE_RATE;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 1;
/** Filename announced in the multipart upload; servers key the decoder on content, not name. */
const UPLOAD_FILENAME = "recording.wav";

/** 16-bit mono PCM WAV from float samples in [-1, 1]. */
export function encodeWav(pcm: Float32Array, sampleRate: number): Buffer {
  const dataSize = pcm.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // format: PCM
  buffer.writeUInt16LE(1, 22); // channels: mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < pcm.length; i++) {
    const sample = Math.max(-1, Math.min(1, pcm[i]!));
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  return buffer;
}

/** Base64 data URL of a WAV buffer, the shape the chat dialect expects. */
export function wavToDataUrl(wav: Buffer): string {
  return `data:audio/wav;base64,${wav.toString("base64")}`;
}

/**
 * Chat-completions body with an `input_audio` content block carrying the WAV
 * recording as a base64 data URL. Generic OpenAI-compatible shape — no
 * provider-specific extensions are attached.
 */
export function buildChatBody(
  model: string,
  dataUrl: string,
): Record<string, unknown> {
  return {
    model,
    messages: [
      {
        role: "user",
        content: [{ type: "input_audio", input_audio: { data: dataUrl } }],
      },
    ],
    stream: false,
  };
}

type ChatCompletionLike = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

/** Transcript text out of a response body, with the same empty check for both styles. */
function requireTranscript(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("the ASR endpoint returned an empty transcript");
  }
  return text;
}

/**
 * `chat` request style: the recording rides an `input_audio` block on
 * `/chat/completions` as a base64 WAV data URL. Audio-capable chat models
 * (OpenAI's `gpt-4o-audio-preview`, omni-style servers) answer this way.
 */
function chatTransport(client: OpenAI, model: string): AsrTransport {
  return async (request, signal) => {
    const completion = (await client.chat.completions.create(
      buildChatBody(model, wavToDataUrl(request.wav)) as never,
      { signal } as never,
    )) as ChatCompletionLike;
    return requireTranscript(completion.choices?.[0]?.message?.content);
  };
}

/**
 * `transcriptions` request style: multipart WAV upload to
 * `/audio/transcriptions`. Dedicated ASR servers (OpenAI's `whisper-1`,
 * whisper.cpp-based servers such as Lemonade) expose this route and reject
 * `input_audio` chat requests, so the two styles are not interchangeable.
 */
function transcriptionsTransport(client: OpenAI, model: string): AsrTransport {
  return async (request, signal) => {
    // A copy into a plain ArrayBuffer: Blob parts reject a Node Buffer whose
    // backing store may be a SharedArrayBuffer.
    const file = new File([new Uint8Array(request.wav)], UPLOAD_FILENAME, {
      type: "audio/wav",
    });
    const result = await client.audio.transcriptions.create({ file, model }, { signal });
    // `json` responses carry { text }; a server answering with a bare text body
    // lands as a string, so both shapes are accepted.
    return requireTranscript(typeof result === "string" ? result : result?.text);
  };
}

/** Build the transport for the configured request style. */
export function createAsrTransport(config: OpenAIAsrSettings): AsrTransport {
  const apiKey = process.env[config.apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new Error(
      `${config.apiKeyEnv} is not set. Export your ASR API key (e.g. in your shell profile) and restart Pi.`,
    );
  }
  const client = new OpenAI({
    apiKey,
    baseURL: config.baseUrl,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });
  return asrEndpointStyle(config) === "transcriptions"
    ? transcriptionsTransport(client, config.model)
    : chatTransport(client, config.model);
}

/**
 * Trims, then applies the Chinese script preference exactly like the local
 * backend. Neither remote response style reports a detected language (a
 * `transcriptions` reply is `{ text }` unless `verbose_json` is requested), so
 * Chinese is inferred from the text itself: Han characters mean the transcript
 * is Chinese and the preference applies, matching local models that detect it.
 */
export async function finishRemoteTranscript(
  text: string,
  options: TranscriptionOptions,
): Promise<string> {
  const trimmed = text.trim();
  return isChineseLanguage(options.language ?? "") || containsChineseCharacters(trimmed)
    ? convertChineseOutput(trimmed, options.chineseOutput ?? "simplified")
    : trimmed;
}

export type OpenAIAsrBackendDeps = {
  /** Overrides the network transport (tests). */
  transport?: AsrTransport;
};

/**
 * Batch-only remote backend: `startStream` resolves to undefined so the
 * service records the whole clip and transcribes it after stop, exactly like
 * a non-streaming local model. Remote failures surface to the caller; there
 * is no local fallback.
 */
export class OpenAIAsrBackend {
  private transport: AsrTransport | undefined;
  private disposed = false;
  private readonly injected: AsrTransport | undefined;

  constructor(
    private readonly config: OpenAIAsrSettings,
    private readonly deps: OpenAIAsrBackendDeps = {},
  ) {
    this.injected = deps.transport;
  }

  async prepare(): Promise<void> {
    if (this.disposed) throw new Error("Remote ASR backend has been disposed");
    // The transport is created lazily in transcribe() so that a missing API
    // key surfaces per recording instead of failing prepare() and blocking
    // every subsequent transcription.
  }

  /** Batch-only: the dictation service drops live chunks and transcribes on stop. */
  async startStream(): Promise<DictationStream | undefined> {
    return undefined;
  }

  async transcribe(
    pcm: Float32Array,
    options: TranscriptionOptions = {},
  ): Promise<string> {
    if (pcm.length === 0) throw new Error("No audio samples were provided");
    const signal = options.signal;
    try {
      let transport = this.injected;
      if (!transport) {
        if (this.disposed) throw new Error("Remote ASR backend has been disposed");
        // Lazily build the transport inside the try so a missing API key or
        // any construction failure is reported like a request failure.
        // Success is cached; a failure is not, so a later call retries once
        // the env is fixed.
        this.transport ??= createAsrTransport(this.config);
        transport = this.transport;
      }
      signal?.throwIfAborted();
      // Only the WAV bytes travel; the chat transport derives its data URL,
      // so an upload-only backend never pays for the base64 copy.
      const text = await transport({ wav: encodeWav(pcm, SAMPLE_RATE) }, signal);
      signal?.throwIfAborted();
      writeLog(
        "debug",
        "voice",
        `remote ASR transcribed ${(pcm.length / SAMPLE_RATE).toFixed(1)}s`,
      );
      return await finishRemoteTranscript(text, options);
    } catch (error) {
      if (signal?.aborted || this.disposed) throw error;
      writeLog(
        "warn",
        "voice",
        `remote ASR failed (${describeError(error)})`,
      );
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // openai v7 is fetch-based and keeps no sockets open between requests, so
    // dropping the reference is the whole teardown.
    this.transport = undefined;
  }
}
