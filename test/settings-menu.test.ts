import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { settingsHomeChoices } from "../src/settings-menu.js";
import {
  settingsForModel,
  settingsRemoteOnly,
  type TranscribeSettings,
} from "../src/settings.js";

initTheme("dark");

function configured(modelId: string, preferredLanguages: string[]): TranscribeSettings {
  return settingsForModel(modelId, "/tmp/model", { preferredLanguages });
}

function rowValues(settings: TranscribeSettings): string[] {
  return settingsHomeChoices(settings, "granted").map((choice) => choice.value);
}

const DETECTING_MULTILINGUAL = "nemotron-3.5-asr-streaming-0.6b";
const ENGLISH_ONLY = "parakeet-unified-en-0.6b";

test("Chinese output row shows for a detecting model that supports Chinese", () => {
  // Auto-detection can return Chinese here, so the script preference must be
  // reachable even though neither the language nor the picks name Chinese.
  const settings = configured(DETECTING_MULTILINGUAL, ["en"]);
  assert.equal(settings.transcriptionLanguage, "auto");
  assert.ok(rowValues(settings).includes("chinese-output"));
});

test("Chinese output row hides when nothing can produce Chinese", () => {
  const settings = configured(ENGLISH_ONLY, ["en"]);
  assert.ok(!rowValues(settings).includes("chinese-output"));
});

test("Chinese output row shows when a preferred language is Chinese", () => {
  const settings = configured(ENGLISH_ONLY, ["zh-CN"]);
  assert.ok(rowValues(settings).includes("chinese-output"));
});

test("remote-only settings hide the local model rows and keep Chinese output reachable", () => {
  // Remote mode stores no local model, so neither the model nor the
  // model-derived transcription language row applies. The endpoint can always
  // produce Chinese, so the script preference must never be gated away.
  const settings = settingsRemoteOnly({
    preferredLanguages: ["en"],
    backend: {
      type: "openai-asr",
      baseUrl: "https://asr.example.com/v1",
      model: "whisper-test",
      apiKeyEnv: "PI_VOICE_TEST_KEY",
    },
  });
  assert.equal(settings.model, undefined);
  const rows = rowValues(settings);
  assert.ok(!rows.includes("model"));
  assert.ok(!rows.includes("transcription-language"));
  assert.ok(rows.includes("backend"));
  assert.ok(rows.includes("chinese-output"));
});

test("local settings show the model and transcription language rows", () => {
  const settings = configured(DETECTING_MULTILINGUAL, ["en"]);
  const rows = rowValues(settings);
  assert.ok(rows.includes("model"));
  assert.ok(rows.includes("transcription-language"));
});

test("picking a local model always yields local-only settings", () => {
  // The backends are exclusive: a selected model drops any remote config.
  const settings = settingsForModel(DETECTING_MULTILINGUAL, "/tmp/model", {
    preferredLanguages: ["en"],
    backend: {
      type: "openai-asr",
      baseUrl: "https://asr.example.com/v1",
      model: "whisper-test",
      apiKeyEnv: "PI_VOICE_TEST_KEY",
    },
  });
  assert.deepEqual(settings.backend, { type: "transcribe-cpp" });
  assert.equal(settings.model?.id, DETECTING_MULTILINGUAL);
});
