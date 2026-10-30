import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initTheme,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { choosePolishModel, settingsHomeChoices } from "../src/settings-menu.js";
import {
  settingsForModel,
  settingsRemoteOnly,
  type PolishModelRef,
  type TranscribeSettings,
} from "../src/settings.js";
import { SingleSelectPicker } from "../src/ui-components.js";
import { keybindings, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");

function configured(modelId: string, preferredLanguages: string[]): TranscribeSettings {
  return settingsForModel(modelId, "/tmp/model", {
    shortcut: "ctrl+alt+z",
    preferredLanguages,
  });
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
    shortcut: "ctrl+alt+z",
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
    shortcut: "ctrl+alt+z",
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

type RegistryModel = { provider: string; id: string; name: string };

const REGISTRY: RegistryModel[] = [
  { provider: "openai", id: "whisper-1", name: "Whisper" },
  {
    provider: "groq",
    id: "whisper-large-v3-turbo",
    name: "Whisper Large v3 Turbo",
  },
  { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
];

/** Open the post-processing model picker against a fake model registry. */
function openPolishModelPicker(
  current?: PolishModelRef,
  models: RegistryModel[] = REGISTRY,
) {
  let pane: SingleSelectPicker<string> | undefined;
  let finish: ((value: string | undefined) => void) | undefined;
  const ctx = {
    modelRegistry: {
      getAvailable: () => models,
      getAll: () => models,
    },
    ui: {
      custom: (
        factory: (
          tui: unknown,
          theme: unknown,
          kb: unknown,
          done: (value: string | undefined) => void,
        ) => unknown,
      ) => {
        const pending = new Promise<string | undefined>((resolve) => {
          finish = resolve;
        });
        pane = factory(
          testTui(24),
          testTheme(),
          keybindings(),
          (value: string | undefined) => finish?.(value),
        ) as SingleSelectPicker<string>;
        return pending;
      },
    },
  } as unknown as ExtensionContext;
  const result = choosePolishModel(ctx, current);
  if (!pane) throw new Error("post-processing model picker did not open");
  const picker = pane;
  return {
    picker,
    /** Type a search query one character at a time, like a keystroke. */
    type: (text: string) => {
      for (const char of text) picker.handleInput(char);
    },
    press: (key: string) => picker.handleInput(key),
    result,
  };
}

function filteredValues(picker: SingleSelectPicker<string>): string[] {
  return (picker as unknown as { filtered: Array<{ value: string }> })
    .filtered.map((choice) => choice.value);
}

function selectedIndex(picker: SingleSelectPicker<string>): number {
  return (picker as unknown as { selectedIndex: number }).selectedIndex;
}

function rendered(picker: SingleSelectPicker<string>): string {
  return picker.render(80).join("\n");
}

test("post-processing model picker fuzzy-searches the registry instead of scrolling it", () => {
  // "wspr" is not a contiguous substring of "whisper-1", so exact matching
  // would return nothing: the registry has to be fuzzy-searchable, the same
  // way the transcription model picker is.
  const { picker, type } = openPolishModelPicker();
  type("wspr");
  const found = filteredValues(picker);
  assert.ok(found.includes("openai/whisper-1"), found.join(", "));
  assert.ok(found.includes("groq/whisper-large-v3-turbo"), found.join(", "));
  assert.ok(!found.includes("anthropic/claude-opus-4-5"), found.join(", "));
  const shown = rendered(picker);
  assert.match(shown, /openai\/whisper-1/);
  assert.doesNotMatch(shown, /anthropic\/claude-opus-4-5/);
});

test("searching the post-processing models and confirming picks that model", async () => {
  const { picker, type, press, result } = openPolishModelPicker();
  type("claude");
  // The cursor sits on the best match, so Enter picks it.
  assert.equal(
    filteredValues(picker)[selectedIndex(picker)],
    "anthropic/claude-opus-4-5",
  );
  press("\r");
  assert.deepEqual(await result, {
    provider: "anthropic",
    id: "claude-opus-4-5",
  });
});

test("post-processing model picker defaults to Pi's current model", async () => {
  const { press, result } = openPolishModelPicker();
  press("\r");
  assert.equal(await result, "current");
});

test("escape clears the post-processing model search and restores the list", () => {
  const { picker, type, press } = openPolishModelPicker();
  type("zzzz");
  assert.deepEqual(filteredValues(picker), []);
  assert.match(rendered(picker), /No matching choices/);
  press("\x1b");
  assert.equal(filteredValues(picker).length, REGISTRY.length + 1);
});

test("the configured post-processing model is the highlighted row", () => {
  const { picker } = openPolishModelPicker({
    provider: "anthropic",
    id: "claude-opus-4-5",
  });
  assert.equal(
    filteredValues(picker)[selectedIndex(picker)],
    "anthropic/claude-opus-4-5",
  );
});

test("a thousand-model registry stays searchable and fits the pane", () => {
  const models: RegistryModel[] = Array.from({ length: 1200 }, (_, index) => ({
    provider: `prov${index % 7}`,
    id: `model-${index}`,
    name: `Model ${index}`,
  }));
  models.push({ provider: "openai", id: "whisper-1", name: "Whisper" });
  const { picker, type } = openPolishModelPicker(undefined, models);
  type("wspr");
  assert.deepEqual(filteredValues(picker), ["openai/whisper-1"]);
  const lines = picker.render(80);
  // 1200 registry models + the whisper override + "Pi's current model".
  assert.match(lines.join("\n"), /1\/1202 matching choices/);
  assert.ok(lines.length <= 22, `${lines.length} rows at 80x24`);
});
