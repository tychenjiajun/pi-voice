import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { CATALOG_MODELS, LANGUAGE_DETECTION_MODEL } from "../src/catalog.js";
import { Deferred } from "../src/deferred.js";
import { CatalogModelPicker } from "../src/model-picker.js";
import {
  choosePolishModel,
  choosePolishPromptSource,
  editPostProcessingPrompt,
  settingsHomeChoices,
  showSettingsMenu,
} from "../src/settings-menu.js";
import { POLISH_SYSTEM_PROMPT } from "../src/polish.js";
import {
  MAX_POLISH_PROMPT_LENGTH,
  readSettings,
  settingsForModel,
  settingsRemoteOnly,
  writeSettings,
  type PolishModelRef,
  type TranscribeSettings,
} from "../src/settings.js";
import { SingleSelectPicker } from "../src/ui-components.js";
import { cacheCatalogModel, isolatedModelCache } from "./model-cache-helper.js";
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

function postProcessingPromptRow(settings: TranscribeSettings) {
  return settingsHomeChoices(settings, "granted").find(
    (choice) => choice.value === "post-processing-prompt",
  );
}

test("the post-processing prompt row reports the built-in default and custom prompts", () => {
  const base = { ...configured(ENGLISH_ONLY, ["en"]), polishEnabled: true };
  assert.equal(postProcessingPromptRow(base)?.summary, "Built-in default");
  const custom = { ...base, polishPrompt: "Only fix punctuation." };
  assert.equal(postProcessingPromptRow(custom)?.summary, "Custom (21 chars)");
});

test("the post-processing prompt row follows the post-processing toggle", () => {
  const off = configured(ENGLISH_ONLY, ["en"]);
  assert.equal(off.polishEnabled, false);
  assert.ok(!rowValues(off).includes("post-processing-prompt"));
  assert.ok(rowValues({ ...off, polishEnabled: true }).includes("post-processing-prompt"));
});

type PickerContext = {
  picker: SingleSelectPicker<"default" | "custom">;
  press: (key: string) => void;
  result: Promise<"default" | "custom" | undefined>;
};

/** Drive choosePolishPromptSource like a user with arrow keys and Enter. */
function openPolishPromptSourcePicker(current?: string): PickerContext {
  let picker: SingleSelectPicker<"default" | "custom"> | undefined;
  let finish: ((value: "default" | "custom" | undefined) => void) | undefined;
  const ctx = {
    ui: {
      custom: (
        factory: (
          tui: unknown,
          theme: unknown,
          kb: unknown,
          done: (value: "default" | "custom" | undefined) => void,
        ) => unknown,
      ) => {
        const pending = new Promise<"default" | "custom" | undefined>((resolve) => {
          finish = resolve;
        });
        picker = factory(
          testTui(24),
          testTheme(),
          keybindings(),
          (value) => finish?.(value),
        ) as SingleSelectPicker<"default" | "custom">;
        return pending;
      },
    },
  } as unknown as ExtensionContext;
  const result = choosePolishPromptSource(ctx, current);
  if (!picker) throw new Error("prompt source picker did not open");
  const open = picker;
  return {
    picker: open,
    press: (key: string) => open.handleInput(key),
    result,
  };
}

function selectedValue(picker: SingleSelectPicker<"default" | "custom">): string {
  const state = picker as unknown as {
    filtered: Array<{ value: string }>;
    selectedIndex: number;
  };
  return state.filtered[state.selectedIndex]!.value;
}

test("the prompt source picker highlights the prompt in use", () => {
  assert.equal(selectedValue(openPolishPromptSourcePicker().picker), "default");
  assert.equal(
    selectedValue(openPolishPromptSourcePicker("Only fix punctuation.").picker),
    "custom",
  );
});

test("the prompt source picker returns the chosen source and backs out on escape", async () => {
  const builtIn = openPolishPromptSourcePicker();
  builtIn.press("\r");
  assert.equal(await builtIn.result, "default");

  const backedOut = openPolishPromptSourcePicker("Custom instructions");
  backedOut.press("\x1b");
  assert.equal(await backedOut.result, undefined);
});

/** Settings directory plus the UI stubs editPostProcessingPrompt touches. */
function promptFlow(t: TestContext, options: {
  source: "default" | "custom" | undefined;
  editor?: string;
}) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(join(tmpdir(), "pi-voice-polish-prompt-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });

  const notifications: Array<{ message: string; type?: string }> = [];
  const editorTitles: string[] = [];
  const editorPrefills: Array<string | undefined> = [];
  const ctx = {
    ui: {
      custom: async () => options.source,
      editor: async (title: string, prefill?: string) => {
        editorTitles.push(title);
        editorPrefills.push(prefill);
        return options.editor;
      },
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
  } as unknown as ExtensionContext;
  return { ctx, notifications, editorTitles, editorPrefills };
}

test("saving a custom prompt writes it to settings", async (t) => {
  const { ctx, notifications, editorTitles, editorPrefills } = promptFlow(t, {
    source: "custom",
    editor: "\n  Only fix punctuation. \n",
  });
  const configured = settingsForModel(ENGLISH_ONLY, "/tmp/model", {
    shortcut: "ctrl+alt+z",
  });
  assert.equal(await editPostProcessingPrompt(ctx, configured), true);
  assert.deepEqual(editorTitles, [
    "Post-processing prompt (clear it to restore the built-in default)",
  ]);
  // Prefilled so the built-in wording can be edited instead of retyped.
  assert.deepEqual(editorPrefills, [POLISH_SYSTEM_PROMPT]);
  assert.equal(configured.polishPrompt, "Only fix punctuation.");
  assert.equal((await readSettings()).settings?.polishPrompt, "Only fix punctuation.");
  assert.match(notifications.at(-1)?.message ?? "", /prompt saved/);
});

test("a prefilled prompt is edited, not replaced by the built-in wording", async (t) => {
  const { ctx, editorPrefills } = promptFlow(t, {
    source: "custom",
    editor: "Custom instructions",
  });
  const configured = settingsForModel(ENGLISH_ONLY, "/tmp/model", {
    shortcut: "ctrl+alt+z",
    polishPrompt: "Only fix punctuation.",
  });
  assert.equal(await editPostProcessingPrompt(ctx, configured), true);
  assert.deepEqual(editorPrefills, ["Only fix punctuation."]);
});

test("clearing the custom prompt restores the built-in prompt", async (t) => {
  const { ctx, notifications } = promptFlow(t, { source: "custom", editor: "   \n" });
  const configured = settingsForModel(ENGLISH_ONLY, "/tmp/model", {
    shortcut: "ctrl+alt+z",
    polishPrompt: "Only fix punctuation.",
  });
  assert.equal(await editPostProcessingPrompt(ctx, configured), true);
  assert.equal(configured.polishPrompt, undefined);
  assert.equal((await readSettings()).settings?.polishPrompt, undefined);
  assert.match(notifications.at(-1)?.message ?? "", /reset to the built-in default/);
});

test("choosing the built-in prompt drops a stored custom one", async (t) => {
  const { ctx } = promptFlow(t, { source: "default" });
  const configured = settingsForModel(ENGLISH_ONLY, "/tmp/model", {
    shortcut: "ctrl+alt+z",
    polishPrompt: "Only fix punctuation.",
  });
  assert.equal(await editPostProcessingPrompt(ctx, configured), true);
  assert.equal((await readSettings()).settings?.polishPrompt, undefined);
});

test("saving the prefilled built-in prompt unchanged keeps the default", async (t) => {
  // The editor opens on the built-in wording, so confirming it unchanged must
  // not persist a copy that would label the row "Custom".
  const { ctx, notifications } = promptFlow(t, {
    source: "custom",
    editor: `\n  ${POLISH_SYSTEM_PROMPT} \n`,
  });
  const configured = settingsForModel(ENGLISH_ONLY, "/tmp/model", {
    shortcut: "ctrl+alt+z",
    polishEnabled: true,
  });
  assert.equal(await editPostProcessingPrompt(ctx, configured), false);
  assert.equal(configured.polishPrompt, undefined);
  assert.equal((await readSettings()).settings?.polishPrompt, undefined);
  assert.equal(postProcessingPromptRow(configured)?.summary, "Built-in default");
  assert.deepEqual(notifications, []);
});

test("an unchanged or cancelled prompt edit saves nothing", async (t) => {
  const unchanged = promptFlow(t, {
    source: "custom",
    editor: "Only fix punctuation.",
  });
  const configured = settingsForModel(ENGLISH_ONLY, "/tmp/model", {
    shortcut: "ctrl+alt+z",
    polishPrompt: "Only fix punctuation.",
  });
  assert.equal(await editPostProcessingPrompt(unchanged.ctx, configured), false);

  const cancelled = promptFlow(t, { source: "custom", editor: undefined });
  assert.equal(await editPostProcessingPrompt(cancelled.ctx, configured), false);

  const alreadyDefault = promptFlow(t, { source: "default" });
  const plain = settingsForModel(ENGLISH_ONLY, "/tmp/model", { shortcut: "ctrl+alt+z" });
  assert.equal(await editPostProcessingPrompt(alreadyDefault.ctx, plain), false);

  const backedOut = promptFlow(t, { source: undefined });
  assert.equal(await editPostProcessingPrompt(backedOut.ctx, configured), false);
});

test("an over-long prompt is rejected instead of stored", async (t) => {
  const { ctx, notifications } = promptFlow(t, {
    source: "custom",
    editor: "x".repeat(MAX_POLISH_PROMPT_LENGTH + 1),
  });
  const configured = settingsForModel(ENGLISH_ONLY, "/tmp/model", {
    shortcut: "ctrl+alt+z",
  });
  assert.equal(await editPostProcessingPrompt(ctx, configured), false);
  assert.equal(configured.polishPrompt, undefined);
  assert.match(notifications.at(-1)?.message ?? "", /too long/);
  assert.equal(notifications.at(-1)?.type, "error");
});

type Step = (pane: Component, done: (value: unknown) => void) => void;

/** Drive showSettingsMenu like a user, one pane at a time. */
function scriptedContext(steps: Step[]) {
  let index = 0;
  const notifications: Array<{ message: string; type?: string }> = [];
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
        const result = new Deferred<unknown>();
        const pane = await factory(
          testTui(24), testTheme(), keybindings() as Parameters<typeof factory>[2],
          (value) => result.resolve(value),
        );
        try {
          const step = steps[index++];
          assert.ok(step, `Unexpected pane: ${pane.constructor.name}`);
          step(pane, (value) => result.resolve(value));
          return await result.promise;
        } finally {
          pane.dispose?.();
        }
      },
      notify: (message: string, type?: string) => { notifications.push({ message, type }); },
    },
  } as unknown as ExtensionContext;
  return { ctx, notifications, assertFinished: () => assert.equal(index, steps.length) };
}

/** Settings directory plus a cached catalog model the pickers may select. */
function settingsMenuFlow(t: TestContext) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(join(tmpdir(), "pi-voice-settings-flow-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const cache = isolatedModelCache(t);
  cacheCatalogModel(cache, LANGUAGE_DETECTION_MODEL);
  cacheCatalogModel(
    cache,
    CATALOG_MODELS.find((model) => model.id === "parakeet-unified-en-0.6b")!,
  );
}

test("switching the backend to local keeps a custom post-processing prompt", async (t) => {
  settingsMenuFlow(t);
  const prompt = "Only fix punctuation; keep the speaker's wording.";
  const configured = settingsRemoteOnly({
    shortcut: "ctrl+alt+z",
    preferredLanguages: ["en"],
    backend: {
      type: "openai-asr",
      baseUrl: "https://asr.example.com/v1",
      model: "whisper-test",
      apiKeyEnv: "PI_VOICE_TEST_KEY",
    },
    polishEnabled: true,
    polishPrompt: prompt,
  });
  await writeSettings(configured);

  const script = scriptedContext([
    // Local mode needs a model, so the backend row detours through the picker.
    (pane) => pickRow(pane, "backend"),
    (pane, done) => {
      assert.ok(pane instanceof SingleSelectPicker, pane.constructor.name);
      done("transcribe-cpp");
    },
    (pane) => pickModel(pane, "parakeet"),
    (pane) => pane.handleInput?.("\x1b"),
  ]);
  assert.equal(await showSettingsMenu({} as ExtensionAPI, script.ctx, configured, "ctrl+alt+z"), false);
  script.assertFinished();

  const saved = (await readSettings()).settings;
  assert.equal(saved?.backend.type, "transcribe-cpp");
  assert.equal(saved?.polishPrompt, prompt);
  assert.equal(configured.polishPrompt, prompt);
  assert.equal(configured.backend.type, "transcribe-cpp");
});

test("switching the backend to remote keeps a custom post-processing prompt", async (t) => {
  settingsMenuFlow(t);
  const prompt = "Only fix punctuation; keep the speaker's wording.";
  const configured = settingsForModel("parakeet-unified-en-0.6b", "/tmp/model", {
    shortcut: "ctrl+alt+z",
    preferredLanguages: ["en"],
    polishEnabled: true,
    polishPrompt: prompt,
  });
  await writeSettings(configured);

  const script = scriptedContext([
    (pane) => pickRow(pane, "backend"),
    (pane, done) => {
      assert.ok(pane instanceof SingleSelectPicker, pane.constructor.name);
      done("openai-asr");
    },
    (_pane, done) => done("https://asr.example.com/v1"),
    (_pane, done) => done("whisper-test"),
    (_pane, done) => done("PI_VOICE_TEST_KEY"),
    (pane) => pane.handleInput?.("\x1b"),
  ]);
  process.env.PI_VOICE_TEST_KEY = "test-key";
  t.after(() => { delete process.env.PI_VOICE_TEST_KEY; });
  await showSettingsMenu({} as ExtensionAPI, script.ctx, configured, "ctrl+alt+z");
  script.assertFinished();

  const saved = (await readSettings()).settings;
  assert.equal(saved?.backend.type, "openai-asr");
  assert.equal(saved?.polishPrompt, prompt);
  assert.equal(configured.polishPrompt, prompt);
});

/** Move the settings-home cursor onto a row and open it. */
function pickRow(pane: Component, value: string): void {
  assert.ok(pane instanceof SingleSelectPicker, pane.constructor.name);
  const state = pane as unknown as {
    filtered: Array<{ value: string }>;
    selectedIndex: number;
  };
  const index = state.filtered.findIndex((choice) => choice.value === value);
  assert.ok(index >= 0, `settings row ${value} is missing`);
  for (let step = state.selectedIndex; step < index; step += 1) pane.handleInput("\x1b[B");
  pane.handleInput("\r");
}

/** Type a query into the catalog picker, select the match, then close it. */
function pickModel(pane: Component, query: string): void {
  assert.ok(pane instanceof CatalogModelPicker, pane.constructor.name);
  for (const char of query) pane.handleInput(char);
  pane.handleInput("\r");
  // The first Esc clears the search, the second leaves once the save lands.
  pane.handleInput("\x1b");
  pane.handleInput("\x1b");
}
