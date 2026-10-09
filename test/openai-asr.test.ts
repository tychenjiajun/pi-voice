import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatBody,
  encodeWav,
  finishRemoteTranscript,
  OpenAIAsrBackend,
  toDataUrl,
  type AsrRequest,
} from "../src/openai-asr.js";
import type { TranscriptionOptions } from "../src/transcription.js";

const CONFIG = {
  type: "openai-asr",
  baseUrl: "https://example.com/v1",
  model: "asr-model",
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

test("buildChatBody sends an input_audio block with no provider-specific fields", () => {
  const dataUrl = "data:audio/wav;base64,AA==";
  const body = buildChatBody("asr-model", dataUrl);
  assert.equal(body.stream, false);
  assert.equal(body.asr_options, undefined, "no provider-specific asr_options extension");
  const messages = body.messages as Array<{
    content: Array<{ type: string; input_audio: { data: string } }>;
  }>;
  assert.equal(messages[0]!.content[0]!.type, "input_audio");
  assert.equal(messages[0]!.content[0]!.input_audio.data, dataUrl);
});

test("finishRemoteTranscript trims and applies the Chinese output preference", async () => {
  const options: TranscriptionOptions = {
    language: "zh",
    chineseOutput: "traditional-taiwan",
  };
  const simplified = await finishRemoteTranscript("  简体中文  ", options);
  assert.equal(simplified, "簡體中文");

  // No configured language: no conversion, mirroring the local path which
  // has no detected language to act on here.
  const unconfigured = await finishRemoteTranscript("简体中文", {
    chineseOutput: "traditional-taiwan",
  });
  assert.equal(unconfigured, "简体中文");

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

test("a missing API key degrades to the local model instead of failing prepare", async () => {
  delete process.env[CONFIG.apiKeyEnv];
  const fallbackCalls: Float32Array[] = [];
  const backend = new OpenAIAsrBackend(CONFIG, {
    createFallback: async () => ({
      async prepare() {},
      async transcribe(samples: Float32Array) {
        fallbackCalls.push(samples);
        return "local text";
      },
      async dispose() {},
    }),
  });
  await backend.prepare();
  const text = await backend.transcribe(pcm(1));
  assert.equal(text, "local text");
  assert.equal(fallbackCalls.length, 1);
  await backend.dispose();
});

test("without a fallback, a missing API key surfaces from transcribe", async () => {
  delete process.env[CONFIG.apiKeyEnv];
  const backend = new OpenAIAsrBackend(CONFIG);
  await backend.prepare();
  await assert.rejects(
    backend.transcribe(pcm(1)),
    new RegExp(`${CONFIG.apiKeyEnv} is not set`),
  );
  await backend.dispose();
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

test("a failed fallback is re-created on the next attempt", async () => {
  let calls = 0;
  const backend = new OpenAIAsrBackend(CONFIG, {
    transport: async () => {
      throw new Error("HTTP 500");
    },
    createFallback: async () => {
      calls += 1;
      if (calls === 1) throw new Error("local model missing");
      return {
        async prepare() {},
        async transcribe() {
          return "local text";
        },
        async dispose() {},
      };
    },
  });

  await assert.rejects(backend.transcribe(pcm(1)), /local model missing/);
  const text = await backend.transcribe(pcm(1));
  assert.equal(text, "local text");
  assert.equal(calls, 2, "the fallback factory ran again after the first failure");
  await backend.dispose();
});
