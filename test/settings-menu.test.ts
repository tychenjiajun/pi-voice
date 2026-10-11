import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { settingsHomeChoices } from "../src/settings-menu.js";
import { settingsForModel, type TranscribeSettings } from "../src/settings.js";

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

test("transcription language row explains the remote endpoint detects the language", () => {
  const settings = settingsForModel(DETECTING_MULTILINGUAL, "/tmp/model", {
    preferredLanguages: ["en"],
    backend: {
      type: "openai-asr",
      baseUrl: "https://asr.example.com/v1",
      model: "whisper-test",
      apiKeyEnv: "PI_VOICE_TEST_KEY",
    },
  });
  const row = settingsHomeChoices(settings, "granted").find(
    (choice) => choice.value === "transcription-language",
  );
  assert.match(row?.description ?? "", /remote endpoint detects the language/);
});
