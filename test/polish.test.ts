import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  POLISH_SYSTEM_PROMPT,
  polishTranscript,
  stripThinkingTags,
} from "../src/polish.js";
import {
  readSettings,
  settingsForModel,
  writeSettings,
  type TranscribeSettings,
} from "../src/settings.js";

function fakeContext(overrides: Record<string, unknown> = {}): ExtensionContext {
  return {
    signal: undefined,
    model: { provider: "openai", id: "gpt-4o-mini" },
    modelRegistry: {
      complete: async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "polished text" }],
      }),
    },
    ...overrides,
  } as unknown as ExtensionContext;
}

test("disabled post-processing returns the raw transcript unchanged", async () => {
  let called = false;
  const ctx = fakeContext({
    modelRegistry: {
      complete: async () => {
        called = true;
        throw new Error("should not be called");
      },
    },
  });
  const raw = "raw,  unpolished—text";
  assert.equal(await polishTranscript(ctx, raw, { enabled: false }), raw);
  assert.equal(called, false);
});

test("empty or whitespace-only transcripts skip post-processing", async () => {
  const ctx = fakeContext();
  assert.equal(await polishTranscript(ctx, "", { enabled: true }), "");
  assert.equal(await polishTranscript(ctx, "   \n ", { enabled: true }), "   \n ");
});

test("an already-aborted signal keeps the raw transcript", async () => {
  const controller = new AbortController();
  controller.abort();
  const ctx = fakeContext({ signal: controller.signal });
  const raw = "do not call the model when the operation is aborted";
  assert.equal(await polishTranscript(ctx, raw, { enabled: true }), raw);
});

test("no active Pi model keeps the raw transcript", async () => {
  let called = false;
  const ctx = fakeContext({
    model: undefined,
    modelRegistry: {
      complete: async () => {
        called = true;
        throw new Error("should not be called");
      },
    },
  });
  const raw = "um like please polish this";
  assert.equal(await polishTranscript(ctx, raw, { enabled: true }), raw);
  assert.equal(called, false);
});

test("a successful model response replaces the transcript", async () => {
  const ctx = fakeContext({
    modelRegistry: {
      complete: async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "please polish this" }],
      }),
    },
  });
  assert.equal(await polishTranscript(ctx, "um like please polish this", { enabled: true }), "please polish this");
});

test("a configured override model is resolved through the registry", async () => {
  const override = { provider: "google", id: "gemini-2.5-flash" };
  const used: unknown[] = [];
  const ctx = fakeContext({
    model: { provider: "openai", id: "gpt-5" },
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === override.provider && id === override.id ? override : undefined,
      complete: async (model: unknown) => {
        used.push(model);
        return { stopReason: "stop", content: [{ type: "text", text: "cleaned" }] };
      },
    },
  });
  assert.equal(await polishTranscript(ctx, "raw", { enabled: true, modelRef: override }), "cleaned");
  assert.deepEqual(used, [override]);
});

test("an unavailable override falls back to the agent's current model", async () => {
  const current = { provider: "openai", id: "gpt-5" };
  const used: unknown[] = [];
  const ctx = fakeContext({
    model: current,
    modelRegistry: {
      find: () => undefined,
      complete: async (model: unknown) => {
        used.push(model);
        return { stopReason: "stop", content: [{ type: "text", text: "cleaned" }] };
      },
    },
  });
  assert.equal(
    await polishTranscript(ctx, "raw", { enabled: true, modelRef: { provider: "google", id: "missing" } }),
    "cleaned",
  );
  assert.deepEqual(used, [current]);
});

test("model failures and empty responses keep the raw transcript", async () => {
  const failing = fakeContext({
    modelRegistry: {
      complete: async () => {
        throw new Error("provider unavailable");
      },
    },
  });
  const raw = "keep me";
  assert.equal(await polishTranscript(failing, raw, { enabled: true }), raw);

  const empty = fakeContext({
    modelRegistry: {
      complete: async () => ({ stopReason: "stop", content: [] }),
    },
  });
  assert.equal(await polishTranscript(empty, raw, { enabled: true }), raw);
});

/** Capture the system prompt sent to the model for one refinement. */
async function capturedSystemPrompt(request: {
  prompt?: string;
}): Promise<string | undefined> {
  const prompts: Array<string | undefined> = [];
  const ctx = fakeContext({
    modelRegistry: {
      complete: async (
        _model: unknown,
        context: { systemPrompt?: string },
      ) => {
        prompts.push(context.systemPrompt);
        return { stopReason: "stop", content: [{ type: "text", text: "cleaned" }] };
      },
    },
  });
  await polishTranscript(ctx, "um cleaned", { enabled: true, ...request });
  return prompts[0];
}

test("a custom prompt replaces the built-in system prompt", async () => {
  const custom = "# Role\n\nEdit for a technical audience.";
  assert.equal(await capturedSystemPrompt({ prompt: custom }), custom);
});

test("an absent or blank prompt uses the built-in system prompt", async () => {
  assert.equal(await capturedSystemPrompt({}), POLISH_SYSTEM_PROMPT);
  assert.equal(await capturedSystemPrompt({ prompt: "" }), POLISH_SYSTEM_PROMPT);
  assert.equal(await capturedSystemPrompt({ prompt: "  \n\t " }), POLISH_SYSTEM_PROMPT);
});

test("a custom prompt is trimmed before it is sent", async () => {
  assert.equal(
    await capturedSystemPrompt({ prompt: "\n  custom instructions  \n" }),
    "custom instructions",
  );
});

test("stripThinkingTags removes inline reasoning blocks", () => {
  assert.equal(stripThinkingTags("\u003cthink\u003eweigh options\u003c/think\u003eHello there"), "Hello there");
  assert.equal(
    stripThinkingTags("\u003cthinking\u003ea\u003c/thinking\u003eone \u003cTHINK\u003eb\u003c/THINK\u003etwo"),
    "one two",
  );
  assert.equal(stripThinkingTags("\u003creasoning\u003er\u003c/reasoning\u003efinal"), "final");
  // Unterminated tag: everything after it is reasoning that never closed.
  assert.equal(stripThinkingTags("visible \u003cthink\u003estill going"), "visible");
  assert.equal(stripThinkingTags("no tags here"), "no tags here");
});

test("thinking blocks reported by Pi are ignored and inline tags are stripped", async () => {
  const ctx = fakeContext({
    modelRegistry: {
      complete: async () => ({
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "internal reasoning" },
          { type: "text", text: "cleaned sentence" },
        ],
      }),
    },
  });
  assert.equal(await polishTranscript(ctx, "um cleaned sentence", { enabled: true }), "cleaned sentence");
});

test("a response that is only thinking keeps the raw transcript", async () => {
  const ctx = fakeContext({
    modelRegistry: {
      complete: async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "\u003cthink\u003enothing visible" }],
      }),
    },
  });
  const raw = "keep the raw transcript";
  assert.equal(await polishTranscript(ctx, raw, { enabled: true }), raw);
});

test("settings round-trip preserves post-processing and defaults it off", async (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-polish-settings-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const base = settingsForModel("parakeet-unified-en-0.6b", "/tmp/test-model", { shortcut: "ctrl+alt+z" });
  assert.equal(base.polishEnabled, false);

  const configured: TranscribeSettings = {
    ...base,
    polishEnabled: true,
    polishModel: { provider: "google", id: "gemini-2.5-flash" },
  };
  await writeSettings(configured);
  assert.deepEqual((await readSettings()).settings, configured);

  const withPrompt: TranscribeSettings = {
    ...configured,
    polishPrompt: "Only fix punctuation.\nKeep the speaker's own words.",
  };
  await writeSettings(withPrompt);
  assert.deepEqual((await readSettings()).settings, withPrompt);

  // A blank prompt is not stored: absent means the built-in prompt.
  await writeSettings({ ...withPrompt, polishPrompt: "   " });
  assert.equal((await readSettings()).settings?.polishPrompt, undefined);
  await writeSettings({ ...withPrompt, polishPrompt: 42 as unknown as string });
  assert.equal((await readSettings()).settings?.polishPrompt, undefined);

  const legacy: TranscribeSettings = { ...configured };
  delete legacy.polishEnabled;
  delete legacy.polishModel;
  await writeSettings(legacy);
  const reverted = await readSettings();
  assert.equal(reverted.settings?.polishEnabled, false);
  assert.equal(reverted.settings?.polishModel, undefined);
  assert.equal(reverted.settings?.polishPrompt, undefined);
});