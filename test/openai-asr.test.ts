import assert from "node:assert/strict";
import test from "node:test";
import {
  asrLanguage,
  buildChatBody,
  encodeWav,
  finishRemoteTranscript,
  MAX_SEGMENT_SECONDS,
  OpenAIAsrBackend,
  toDataUrl,
  type AsrRequest,
} from "../src/openai-asr.js";
import type { TranscriptionOptions } from "../src/transcription.js";

const CONFIG = {
  type: "openai-asr",
  baseUrl: "https://example.com/compatible-mode/v1",
  model: "qwen3-asr-flash",
  apiKeyEnv: "PI_VOICE_TEST_KEY",
} as const;

function pcm(seconds: number, sampleRate = 16_000): Float32Array {
  return new Float32Array(Math.round(seconds * sampleRate)).fill(0.25);
}

test("encodeWav writes a valid 16-bit mono header and clamps samples", () => {
  const wav = encodeWav(Float32Array.of(0, 1, -1, 2, -2), 16_000);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(4), 36 + 5 * 2, "RIFF size");
  assert.equal(wav.readUInt16LE(20), 1, "PCM format");
  assert.equal(wav.readUInt16LE(22), 1, "mono");
  assert.equal(wav.readUInt32LE(24), 16_000, "sample rate");
  assert.equal(wav.readUInt16LE(34), 16, "bits per sample");
  assert.equal(wav.readUInt32LE(40), 10, "data size");
  assert.equal(wav.readInt16LE(44), 0);
  assert.equal(wav.readInt16LE(46), 32767, "clamped high");
  assert.equal(wav.readInt16LE(48), -32767, "clamped low");
  assert.equal(wav.readInt16LE(50), 32767, "input above 1 clamps");
  assert.equal(wav.readInt16LE(52), -32767, "input below -1 clamps");
});

test("toDataUrl produces a base64 WAV data URL", () => {
  const url = toDataUrl(Float32Array.of(0.5), 16_000);
  assert.match(url, /^data:audio\/wav;base64,/);
  const decoded = Buffer.from(url.slice("data:audio/wav;base64,".length), "base64");
  assert.equal(decoded.toString("ascii", 0, 4), "RIFF");
});

test("asrLanguage normalizes codes and maps auto to absent", () => {
  assert.equal(asrLanguage(undefined), undefined);
  assert.equal(asrLanguage("auto"), undefined);
  assert.equal(asrLanguage("zh-CN"), "zh");
  assert.equal(asrLanguage("en-US"), "en");
  assert.equal(asrLanguage("pt-BR"), "pt");
  assert.equal(asrLanguage("zh"), "zh");
});

test("buildChatBody attaches asr_options only for ASR models or explicit language", () => {
  const dataUrl = "data:audio/wav;base64,AA==";

  const asr = buildChatBody("qwen3-asr-flash", dataUrl, "zh");
  assert.equal(asr.stream, false);
  assert.deepEqual(asr.asr_options, { enable_itn: false, language: "zh" });
  const messages = asr.messages as Array<{
    content: Array<{ type: string; input_audio: { data: string } }>;
  }>;
  assert.equal(messages[0]!.content[0]!.type, "input_audio");
  assert.equal(messages[0]!.content[0]!.input_audio.data, dataUrl);

  // A plain chat model without a language hint must not see the DashScope extension.
  const plain = buildChatBody("some-chat-model", dataUrl, undefined);
  assert.equal(plain.asr_options, undefined);
});

test("finishRemoteTranscript trims and applies the Chinese output preference", async () => {
  const options: TranscriptionOptions = {
    language: "zh",
    chineseOutput: "traditional-taiwan",
  };
  const simplified = await finishRemoteTranscript("  简体中文  ", options);
  assert.equal(simplified, "簡體中文");

  // Auto-detected language: CJK content still triggers conversion.
  const auto = await finishRemoteTranscript("简体中文", {
    chineseOutput: "traditional-taiwan",
  });
  assert.equal(auto, "簡體中文");

  const english = await finishRemoteTranscript("  hello world  ", {});
  assert.equal(english, "hello world");
});

test("transcribe uploads one WAV data URL and returns the transcript", async () => {
  const requests: AsrRequest[] = [];
  const backend = new OpenAIAsrBackend(CONFIG, {
    transport: async (request) => {
      requests.push(request);
      return "remote text";
    },
  });
  await backend.prepare();

  const text = await backend.transcribe(pcm(1));
  assert.equal(text, "remote text");
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.dataUrl, /^data:audio\/wav;base64,/);
  assert.equal(requests[0]!.language, undefined, "auto detection sends no language");
  await backend.dispose();
});

test("transcribe forwards the normalized language hint", async () => {
  const requests: AsrRequest[] = [];
  const backend = new OpenAIAsrBackend(CONFIG, {
    transport: async (request) => {
      requests.push(request);
      return "你好";
    },
  });
  await backend.transcribe(pcm(1), { language: "zh-CN" });
  assert.equal(requests[0]!.language, "zh");
  await backend.dispose();
});

test("recordings beyond the segment limit are split into multiple requests", async () => {
  const requests: AsrRequest[] = [];
  const backend = new OpenAIAsrBackend(CONFIG, {
    transport: async (request) => {
      requests.push(request);
      return `part-${requests.length}`;
    },
  });
  const long = pcm(MAX_SEGMENT_SECONDS + 1);
  const text = await backend.transcribe(long);
  assert.equal(requests.length, 2);
  assert.equal(text, "part-1\npart-2");
  await backend.dispose();
});

test("a remote failure falls back to the local model", async () => {
  const fallbackCalls: Float32Array[] = [];
  const backend = new OpenAIAsrBackend(CONFIG, {
    transport: async () => {
      throw new Error("HTTP 500");
    },
    createFallback: async () => ({
      async prepare() {},
      async transcribe(samples: Float32Array) {
        fallbackCalls.push(samples);
        return "local text";
      },
      async dispose() {},
    }),
  });

  const samples = pcm(1);
  const text = await backend.transcribe(samples);
  assert.equal(text, "local text");
  assert.equal(fallbackCalls.length, 1);
  assert.equal(fallbackCalls[0], samples, "the full clip reaches the fallback");
  await backend.dispose();
});

test("aborting during a remote call never falls back", async () => {
  const controller = new AbortController();
  const backend = new OpenAIAsrBackend(CONFIG, {
    transport: async () => {
      controller.abort();
      throw new Error("aborted");
    },
    createFallback: async () => ({
      async prepare() {},
      async transcribe() {
        throw new Error("fallback must not run");
      },
      async dispose() {},
    }),
  });

  await assert.rejects(
    backend.transcribe(pcm(1), { signal: controller.signal }),
    /aborted/,
  );
  await backend.dispose();
});

test("without a fallback configured, remote errors surface directly", async () => {
  const backend = new OpenAIAsrBackend(CONFIG, {
    transport: async () => {
      throw new Error("HTTP 401");
    },
  });
  await assert.rejects(backend.transcribe(pcm(1)), /HTTP 401/);
  await backend.dispose();
});

test("prepare fails clearly when the API key variable is unset", async () => {
  delete process.env[CONFIG.apiKeyEnv];
  const backend = new OpenAIAsrBackend(CONFIG);
  await assert.rejects(backend.prepare(), new RegExp(`${CONFIG.apiKeyEnv} is not set`));
});

test("startStream is undefined so the service takes the batch path", async () => {
  const backend = new OpenAIAsrBackend(CONFIG, {
    transport: async () => "text",
  });
  assert.equal(await backend.startStream(), undefined);
  await backend.dispose();
});

test("empty audio is rejected like the local backend", async () => {
  const backend = new OpenAIAsrBackend(CONFIG, {
    transport: async () => "text",
  });
  await assert.rejects(backend.transcribe(new Float32Array(0)), /No audio samples/);
  await backend.dispose();
});
