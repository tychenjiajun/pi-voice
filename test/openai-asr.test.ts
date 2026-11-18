import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  buildChatBody,
  createAsrTransport,
  encodeWav,
  finishRemoteTranscript,
  OpenAIAsrBackend,
  wavToDataUrl,
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

test("wavToDataUrl produces a base64 WAV data URL", () => {
  const url = wavToDataUrl(encodeWav(Float32Array.of(0.5), 16_000));
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

  // No configured language: remote ASR reports none, so Han characters in the
  // transcript decide — matching local models that detect Chinese themselves.
  const detected = await finishRemoteTranscript("简体中文", {
    chineseOutput: "traditional-taiwan",
  });
  assert.equal(detected, "簡體中文");

  const english = await finishRemoteTranscript("  hello world  ", {});
  assert.equal(english, "hello world");
});

test("transcribe uploads the WAV recording and returns the transcript", async () => {
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
  assert.equal(requests[0]!.wav.toString("ascii", 0, 4), "RIFF", "raw WAV bytes reach the transport");
  await backend.dispose();
});

test("a remote failure surfaces to the caller", async () => {
  const backend = new OpenAIAsrBackend(CONFIG, {
    transport: async () => {
      throw new Error("HTTP 500");
    },
  });
  await assert.rejects(backend.transcribe(pcm(1)), /HTTP 500/);
  await backend.dispose();
});

test("aborting during a remote call surfaces the abort", async () => {
  const controller = new AbortController();
  const backend = new OpenAIAsrBackend(CONFIG, {
    transport: async () => {
      controller.abort();
      throw new Error("aborted");
    },
  });

  await assert.rejects(
    backend.transcribe(pcm(1), { signal: controller.signal }),
    /aborted/,
  );
  await backend.dispose();
});

test("remote errors surface directly", async () => {
  const backend = new OpenAIAsrBackend(CONFIG, {
    transport: async () => {
      throw new Error("HTTP 401");
    },
  });
  await assert.rejects(backend.transcribe(pcm(1)), /HTTP 401/);
  await backend.dispose();
});

test("a missing API key surfaces from transcribe", async () => {
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

type CapturedRequest = {
  url: string;
  contentType: string;
  body: string;
  authorization: string | undefined;
};

/** Minimal OpenAI-compatible stand-in; records what the transport actually sent. */
async function startAsrServer(
  reply: (request: CapturedRequest) => { status: number; body: unknown },
): Promise<{ baseUrl: string; requests: CapturedRequest[]; close: () => Promise<void> }> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const captured: CapturedRequest = {
        url: req.url ?? "",
        contentType: String(req.headers["content-type"] ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
        authorization: req.headers.authorization,
      };
      requests.push(captured);
      const { status, body } = reply(captured);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("the chat style posts an input_audio block to /chat/completions", async (t) => {
  process.env[CONFIG.apiKeyEnv] = "test-key";
  t.after(() => { delete process.env[CONFIG.apiKeyEnv]; });
  const server = await startAsrServer(() => ({
    status: 200,
    body: { choices: [{ message: { content: " chat text " } }] },
  }));
  try {
    const transport = createAsrTransport({ ...CONFIG, baseUrl: server.baseUrl });
    const wav = encodeWav(Float32Array.of(0.1, 0.2), 16_000);
    // The transport hands back the raw reply; trimming happens with the
    // Chinese script preference in finishRemoteTranscript.
    assert.equal(
      await transport({ wav }),
      " chat text ",
    );
  } finally {
    await server.close();
  }

  assert.equal(server.requests.length, 1);
  const request = server.requests[0]!;
  assert.equal(request.url, "/v1/chat/completions");
  assert.match(request.contentType, /application\/json/);
  assert.equal(request.authorization, "Bearer test-key");
  assert.match(request.body, /"input_audio"/);
});

test("the transcriptions style uploads WAV to /audio/transcriptions", async (t) => {
  process.env[CONFIG.apiKeyEnv] = "test-key";
  t.after(() => { delete process.env[CONFIG.apiKeyEnv]; });
  const server = await startAsrServer(() => ({ status: 200, body: { text: " upload text " } }));
  const wav = encodeWav(Float32Array.of(0.1, 0.2, 0.3), 16_000);
  try {
    const transport = createAsrTransport({
      ...CONFIG,
      baseUrl: server.baseUrl,
      endpointStyle: "transcriptions",
    });
    assert.equal(
      await transport({ wav }),
      " upload text ",
    );
  } finally {
    await server.close();
  }

  assert.equal(server.requests.length, 1);
  const request = server.requests[0]!;
  assert.equal(request.url, "/v1/audio/transcriptions");
  assert.match(request.contentType, /^multipart\/form-data;/);
  assert.match(request.body, /name="model"\r\n\r\nasr-model/);
  assert.match(request.body, /filename="recording\.wav"/);
  assert.ok(
    request.body.includes("RIFF"),
    "the WAV bytes ride in the multipart body",
  );
  assert.ok(
    !request.body.includes("input_audio"),
    "no chat-completions fields leak into the upload",
  );
});

test("the transcriptions style surfaces an empty transcript like the chat style", async (t) => {
  process.env[CONFIG.apiKeyEnv] = "test-key";
  t.after(() => { delete process.env[CONFIG.apiKeyEnv]; });
  const server = await startAsrServer(() => ({ status: 200, body: { text: "   " } }));
  try {
    const transport = createAsrTransport({
      ...CONFIG,
      baseUrl: server.baseUrl,
      endpointStyle: "transcriptions",
    });
    const wav = encodeWav(Float32Array.of(0.1), 16_000);
    await assert.rejects(
      transport({ wav }),
      /empty transcript/,
    );
  } finally {
    await server.close();
  }
});

test("the transcriptions style surfaces an HTTP error with its message", async (t) => {
  process.env[CONFIG.apiKeyEnv] = "test-key";
  t.after(() => { delete process.env[CONFIG.apiKeyEnv]; });
  const server = await startAsrServer(() => ({
    status: 400,
    body: { error: { message: "This model does not support chat completion." } },
  }));
  try {
    const backend = new OpenAIAsrBackend({ ...CONFIG, baseUrl: server.baseUrl, endpointStyle: "transcriptions" });
    await assert.rejects(backend.transcribe(pcm(0.2)), /400|chat completion/);
    await backend.dispose();
  } finally {
    await server.close();
  }
  assert.equal(server.requests[0]!.url, "/v1/audio/transcriptions");
});
