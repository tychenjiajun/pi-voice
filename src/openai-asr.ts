import OpenAI from "openai";
import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import { convertChineseOutput, isChineseLanguage } from "./chinese.js";
import { describeError, writeLog } from "./log.js";
import type { BackendSettings, ChineseOutput } from "./settings.js";
import type {
  DictationStream,
  TranscribeCppBackend,
  TranscriptionOptions,
} from "./transcription.js";

type OpenAIAsrSettings = Extract<BackendSettings, { type: "openai-asr" }>;

/** The slice of the local backend this module needs for offline fallback. */
export type LocalFallback = Pick<
  TranscribeCppBackend,
  "prepare" | "transcribe" | "dispose"
>;

export type AsrRequest = {
  /** `data:audio/wav;base64,…` of one PCM segment. */
  dataUrl: string;
  /** DashScope-style language code (e.g. `zh`), absent for auto-detection. */
  language?: string;
};

/** Uploads one segment and returns the transcript text. Injectable for tests. */
export type AsrTransport = (
  request: AsrRequest,
  signal?: AbortSignal,
) => Promise<string>;

/**
 * Segments longer recordings so the base64 payload stays under the 10 MB cap
 * of OpenAI-compatible ASR endpoints (3 min of 16 kHz mono 16-bit WAV ≈ 5.8 MB
 * raw → ~7.7 MB base64).
 */
export const MAX_SEGMENT_SECONDS = 180;

const SAMPLE_RATE = CAPTURE_SAMPLE_RATE;
const CJK = /[㐀-䶿一-鿿豈-﫿]/;
/** `zh-CN` → `zh`, `pt-BR` → `pt`; auto detection is passed through as absent. */
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 1;

export function asrLanguage(language: string | undefined): string | undefined {
  if (!language || language === "auto") return undefined;
  return language.split("-")[0]!.toLowerCase();
}

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

export function toDataUrl(pcm: Float32Array, sampleRate: number): string {
  return `data:audio/wav;base64,${encodeWav(pcm, sampleRate).toString("base64")}`;
}

/**
 * Chat-completions body for DashScope-compatible ASR. `asr_options` is a
 * DashScope extension, so it is only attached for ASR-named models (mirroring
 * DoubleTapTalk) to keep plain OpenAI-compatible endpoints from rejecting it.
 */
export function buildChatBody(
  model: string,
  dataUrl: string,
  language: string | undefined,
): Record<string, unknown> {
  const asrNamed = model.toLowerCase().includes("asr");
  const asrOptions =
    asrNamed || language !== undefined
      ? { enable_itn: false, ...(language !== undefined ? { language } : {}) }
      : undefined;
  return {
    model,
    messages: [
      {
        role: "user",
        content: [{ type: "input_audio", input_audio: { data: dataUrl } }],
      },
    ],
    stream: false,
    ...(asrOptions ? { asr_options: asrOptions } : {}),
  };
}

type ChatCompletionLike = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

function createOpenAITransport(config: OpenAIAsrSettings): {
  transport: AsrTransport;
  dispose: () => void;
} {
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
  return {
    transport: async (request, signal) => {
      const body = buildChatBody(config.model, request.dataUrl, request.language);
      const completion = (await client.chat.completions.create(
        body as never,
        { signal } as never,
      )) as ChatCompletionLike;
      const content = completion.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("the ASR endpoint returned an empty transcript");
      }
      return content;
    },
    // openai v7 is fetch-based and keeps no sockets open between requests.
    dispose: () => undefined,
  };
}

/** Trims, then applies the Chinese script preference like the local backend. */
export async function finishRemoteTranscript(
  text: string,
  options: TranscriptionOptions,
): Promise<string> {
  const trimmed = text.trim();
  const configured = options.language ?? "";
  const chinese = isChineseLanguage(configured)
    ? true
    : configured === "" && CJK.test(trimmed);
  if (!chinese) return trimmed;
  return convertChineseOutput(trimmed, options.chineseOutput ?? "simplified");
}

export type OpenAIAsrBackendDeps = {
  /** Creates the local model used when a remote call fails. */
  createFallback?: () => Promise<LocalFallback>;
  /** Overrides the network transport (tests). */
  transport?: AsrTransport;
};

/**
 * Batch-only remote backend: `startStream` resolves to undefined so the
 * service records the whole clip and transcribes it after stop, exactly like
 * a non-streaming local model. Remote failures fall back to the local model
 * (DoubleTapTalk's degradation model); aborts are never retried locally.
 */
export class OpenAIAsrBackend {
  private client: { transport: AsrTransport; dispose: () => void } | undefined;
  private fallback: Promise<LocalFallback> | undefined;
  private disposed = false;
  private readonly injected: AsrTransport | undefined;

  constructor(
    private readonly config: OpenAIAsrSettings,
    private readonly deps: OpenAIAsrBackendDeps = {},
  ) {
    this.injected = deps.transport;
  }

  async prepare(): Promise<void> {
    if (this.client || this.injected) return;
    if (this.disposed) throw new Error("Remote ASR backend has been disposed");
    this.client = createOpenAITransport(this.config);
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
      const language = asrLanguage(options.language);
      let transport = this.injected;
      if (!transport) {
        await this.prepare();
        transport = this.client!.transport;
      }
      const perSegment = MAX_SEGMENT_SECONDS * SAMPLE_RATE;
      const parts: string[] = [];
      for (let offset = 0; offset < pcm.length; offset += perSegment) {
        signal?.throwIfAborted();
        const segment = pcm.subarray(
          offset,
          Math.min(offset + perSegment, pcm.length),
        );
        parts.push(
          await transport(
            { dataUrl: toDataUrl(segment, SAMPLE_RATE), language },
            signal,
          ),
        );
        signal?.throwIfAborted();
      }
      writeLog(
        "debug",
        "voice",
        `remote ASR transcribed ${(pcm.length / SAMPLE_RATE).toFixed(1)}s in ${parts.length} request(s)`,
      );
      return await finishRemoteTranscript(parts.join("\n"), options);
    } catch (error) {
      if (signal?.aborted || this.disposed) throw error;
      if (!this.deps.createFallback) throw error;
      writeLog(
        "warn",
        "voice",
        `remote ASR failed (${describeError(error)}); falling back to the local model`,
      );
      try {
        const local = await this.fallbackBackend();
        return await local.transcribe(pcm, options);
      } catch (fallbackError) {
        throw new Error(
          `Remote ASR failed (${describeError(error)}) and the local fallback failed (${describeError(fallbackError)})`,
        );
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.client?.dispose();
    this.client = undefined;
    if (this.fallback) {
      const local = await this.fallback.catch(() => undefined);
      await local?.dispose().catch(() => undefined);
    }
  }

  private fallbackBackend(): Promise<LocalFallback> {
    if (!this.fallback) {
      this.fallback = this.deps.createFallback!();
    }
    return this.fallback;
  }
}
