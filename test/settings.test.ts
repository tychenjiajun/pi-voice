import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSettings,
  settingsForModel,
  settingsRemoteOnly,
  writeSettings,
} from "../src/settings.js";

function isolatedSettings(t: TestContext) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(join(tmpdir(), "pi-voice-settings-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
}

const REMOTE_BACKEND = {
  type: "openai-asr" as const,
  baseUrl: "https://asr.example.com/v1",
  model: "whisper-test",
  apiKeyEnv: "PI_VOICE_TEST_KEY",
};

test("remote-only settings round-trip without a local model", async (t) => {
  isolatedSettings(t);
  const settings = settingsRemoteOnly({
    backend: REMOTE_BACKEND,
    preferredLanguages: ["zh-CN", "en"],
    shortcut: "ctrl+alt+x",
  });
  assert.equal(settings.model, undefined);
  assert.equal(settings.transcriptionLanguage, "auto");

  await writeSettings(settings);
  const { settings: loaded, warning } = await readSettings();
  assert.equal(warning, undefined);
  assert.deepEqual(loaded, settings);
  assert.equal(loaded?.model, undefined);
});

test("a leftover local model is dropped when the backend is remote", async (t) => {
  isolatedSettings(t);
  const crafted = {
    ...settingsForModel("parakeet-unified-en-0.6b", "/tmp/model", { shortcut: "ctrl+alt+z" }),
    backend: REMOTE_BACKEND,
  };
  assert.ok(crafted.model);
  await writeSettings(crafted);

  const { settings: loaded, warning } = await readSettings();
  assert.equal(warning, undefined);
  assert.deepEqual(loaded?.backend, REMOTE_BACKEND);
  assert.equal(loaded?.model, undefined, "remote mode never keeps a local model");
});

test("local settings without a model are rejected", async (t) => {
  isolatedSettings(t);
  const { model: _model, ...base } = settingsForModel("parakeet-unified-en-0.6b", "/tmp/model", { shortcut: "ctrl+alt+z" });
  await writeSettings({ ...base, model: undefined });

  const { settings, warning } = await readSettings();
  assert.equal(settings, undefined);
  assert.match(warning ?? "", /configuration is required/);
});

test("a custom post-processing prompt survives model selection", () => {
  const prompt = "Only fix punctuation; keep the speaker's wording.";
  const local = settingsForModel("parakeet-unified-en-0.6b", "/tmp/model", {
    shortcut: "ctrl+alt+z",
    polishPrompt: prompt,
  });
  assert.equal(local.polishPrompt, prompt);

  const remote = settingsRemoteOnly({
    shortcut: "ctrl+alt+z",
    backend: REMOTE_BACKEND,
    polishPrompt: prompt,
  });
  assert.equal(remote.polishPrompt, prompt);

  const plain = settingsForModel("parakeet-unified-en-0.6b", "/tmp/model", {
    shortcut: "ctrl+alt+z",
  });
  assert.equal("polishPrompt" in plain, false, "absent means the built-in prompt");
});

test("selecting a local model drops any remote configuration", () => {
  const settings = settingsForModel("parakeet-unified-en-0.6b", "/tmp/model", {
    shortcut: "ctrl+alt+z",
    backend: REMOTE_BACKEND,
  });
  assert.deepEqual(settings.backend, { type: "transcribe-cpp" });
  assert.equal(settings.model?.id, "parakeet-unified-en-0.6b");
});
