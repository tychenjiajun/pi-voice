import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { downloadCatalogModel, pendingDownloads } from "./models.js";
import { microphonePermission, type Permission } from "./audio.js";
import { displayLanguage, getCatalogModel, LANGUAGE_DETECTION_MODEL } from "./catalog.js";
import { autoLanguagePolicy } from "./language-detection-policy.js";
import { chineseOutputSummary, isChineseLanguage } from "./chinese.js";
import {
  chooseLanguages,
  createTranscriptionLanguagePicker,
  transcriptionLanguageSummary,
} from "./model-picker.js";
import {
  chooseMicrophone,
  microphonesEqual,
  microphoneSummary,
} from "./microphone-picker.js";
import { runModelSelection } from "./onboarding.js";
import { chooseBackendType, promptRemoteBackend, warnMissingApiKey } from "./remote-asr.js";
import {
  MAX_POLISH_PROMPT_LENGTH,
  settingsWithPreferredLanguages,
  writeSettings,
  type BackendSettings,
  type ChineseOutput,
  type MicrophoneSetting,
  type PolishModelRef,
  type TranscribeSettings,
  type TranscriptionLanguage,
} from "./settings.js";
import { displayShortcut } from "./shortcut-core.js";
import { createShortcutPicker } from "./shortcuts.js";
import { POLISH_SYSTEM_PROMPT } from "./polish.js";
import {
  padToWidth,
  SingleSelectPicker,
  type SingleSelectChoice,
} from "./ui-components.js";

const MACOS_MICROPHONE_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
const SETTINGS_LABEL_WIDTH = 25;
// Text padding (2), cursor gutter (2), label column, and its gap (2).
const SETTINGS_ROW_OVERHEAD = SETTINGS_LABEL_WIDTH + 6;

export type SettingsAction =
  | "preferred-languages"
  | "model"
  | "backend"
  | "transcription-language"
  | "chinese-output"
  | "post-processing"
  | "post-processing-prompt"
  | "microphone"
  | "shortcut";

export type SettingsHomeChoice = SingleSelectChoice<SettingsAction> & {
  summary: string;
  /** Render the summary in the error color. */
  alert?: boolean;
};

function preferredLanguagesSummary(languages: readonly string[]): string {
  const names = languages.map(displayLanguage);
  const visible = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${visible} +${names.length - 3}` : visible;
}

function languagesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.join("\0") === right.join("\0");
}

async function saveUpdatedSettings(
  ctx: ExtensionContext,
  configured: TranscribeSettings,
  updated: TranscribeSettings,
  successMessage?: string,
): Promise<boolean> {
  try {
    await writeSettings(updated);
    Object.assign(configured, updated);
    if (successMessage) ctx.ui.notify(successMessage, "info");
    return true;
  } catch (error) {
    ctx.ui.notify(
      `Could not save settings: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return false;
  }
}

function backendSummary(backend: BackendSettings): string {
  return backend.type === "openai-asr" ? `Remote · ${backend.model}` : "Local model";
}

function polishSummary(polishEnabled: boolean | undefined, model: PolishModelRef | undefined): string {
  if (!polishEnabled) return "Off";
  return model ? `${model.provider}/${model.id}` : "Pi's current model";
}

function polishPromptSummary(prompt: string | undefined): string {
  return prompt ? `Custom (${prompt.length} chars)` : "Built-in default";
}

let detectorDownload: Promise<void> | undefined;

/**
 * Fetch the language detector in the background; until it lands, Auto detect
 * transcribes as `fallback`.
 */
function downloadLanguageDetector(ctx: ExtensionContext, fallback: string): void {
  if (detectorDownload) return;
  ctx.ui.notify("Downloading language detector…", "info");
  detectorDownload = downloadCatalogModel(LANGUAGE_DETECTION_MODEL)
    .then(
      () => ctx.ui.notify("Language detector downloaded. Auto detect is ready.", "info"),
      (error: unknown) => ctx.ui.notify(
        `Couldn't download the language detector (${error instanceof Error ? error.message : String(error)}). ` +
        `Auto detect will use ${displayLanguage(fallback)} until it's downloaded. ` +
        "Choose Auto detect again to retry the download.",
        "error",
      ),
    )
    .catch(() => undefined) // The session may be gone by the time it settles.
    .finally(() => { detectorDownload = undefined; });
}

export function settingsHomeChoices(
  configured: TranscribeSettings,
  permission: Permission,
): SettingsHomeChoice[] {
  // Local mode always carries a model; remote mode never does.
  const model = configured.model ? getCatalogModel(configured.model.id) : undefined;
  const remote = configured.backend.type === "openai-asr";
  const choices: SettingsHomeChoice[] = [
    {
      value: "preferred-languages",
      label: "Preferred languages",
      summary: preferredLanguagesSummary(configured.preferredLanguages),
      description: "Languages you speak, used to rank and recommend transcription models",
    },
  ];

  if (model) {
    choices.push({
      value: "model",
      label: "Model",
      summary: model.name,
      description: "Switch between downloaded models, or download a new one",
    });
  }

  choices.push(
    {
      value: "backend",
      label: "Transcription backend",
      summary: backendSummary(configured.backend),
      description:
        "Local model or remote ASR endpoint; the two modes are exclusive",
    },
    {
      value: "post-processing",
      label: "Post-processing",
      summary: polishSummary(configured.polishEnabled, configured.polishModel),
      description:
        "Refine transcripts with Pi's current model after ASR, like context compaction",
    },
  );

  // The prompt only applies to a refinement that runs, so its row follows the
  // post-processing toggle instead of offering dead configuration.
  if (configured.polishEnabled) {
    choices.push({
      value: "post-processing-prompt",
      label: "Post-processing prompt",
      summary: polishPromptSummary(configured.polishPrompt),
      description:
        "Instructions the post-processing model follows; edit or reset the built-in prompt",
    });
  }

  if (model) {
    choices.push({
      value: "transcription-language",
      label: "Transcription language",
      summary: transcriptionLanguageSummary(configured.transcriptionLanguage, model),
      description: "Language expected in recordings, or automatic detection when supported",
    });
  }

  // Chinese script conversion applies when the configured language is Chinese,
  // when a preferred language is Chinese, or when a detecting model can pick
  // Chinese on its own. Remote mode can always produce Chinese, so its row is
  // never gated.
  const detectsChinese =
    model?.capabilities.languageDetection && model.languages.some(isChineseLanguage);
  if (
    remote ||
    isChineseLanguage(configured.transcriptionLanguage) ||
    configured.preferredLanguages.some(isChineseLanguage) ||
    detectsChinese
  ) {
    choices.push({
      value: "chinese-output",
      label: "Chinese output",
      summary: chineseOutputSummary(configured.chineseOutput),
      description: "Character style used for Chinese transcripts",
    });
  }

  choices.push(
    {
      value: "microphone",
      label: "Microphone",
      // A permission problem replaces the device summary so it is visible
      // from the home screen; selecting the row then goes straight to the
      // System Settings fix.
      ...(permission === "denied" && process.platform === "darwin"
        ? {
            summary: "✗ Access denied",
            alert: true,
            description: "Grant microphone access to the terminal application running Pi",
          }
        : {
            summary: microphoneSummary(configured.microphone),
            description: "Input device used for dictation",
          }),
    },
    {
      value: "shortcut",
      label: "Shortcut",
      summary: displayShortcut(configured.shortcut),
      description: "Terminal shortcut that starts and stops microphone dictation",
    },
  );

  return choices;
}

async function showSettingsHome(
  ctx: ExtensionContext,
  configured: TranscribeSettings,
  permission: Permission,
): Promise<SettingsAction | undefined> {
  return ctx.ui.custom<SettingsAction | undefined>((tui, theme, keybindings, done) => {
    const choices = settingsHomeChoices(configured, permission);
    const rows = new Map(choices.map((choice) => [choice.value, choice]));
    return new SingleSelectPicker(
      tui,
      theme,
      keybindings,
      choices,
      undefined,
      {
        title: "Pi Voice settings",
        cancelLabel: "close",
        renderLabel: (choice, active, width) => {
          const row = rows.get(choice.value);
          const labelText = padToWidth(choice.label, SETTINGS_LABEL_WIDTH);
          const label = active ? theme.fg("accent", labelText) : labelText;
          // Long summaries (language lists, microphone names) truncate so
          // they never wrap the row and break the column layout.
          const summary = truncateToWidth(
            row?.summary ?? "",
            Math.max(12, width - SETTINGS_ROW_OVERHEAD),
            "…",
          );
          const value = row?.alert
            ? theme.fg("error", summary)
            : theme.fg("dim", summary);
          return `${label}  ${value}`;
        },
      },
      done,
    );
  });
}

async function chooseChineseOutput(
  ctx: ExtensionContext,
  current: ChineseOutput,
): Promise<ChineseOutput | undefined> {
  const choices: SingleSelectChoice<ChineseOutput>[] = [
    {
      value: "simplified",
      label: "Simplified",
      description: "Convert Chinese transcripts to simplified characters",
    },
    {
      value: "traditional-taiwan",
      label: "Traditional (Taiwan)",
      description: "Use traditional characters and Taiwan conventions",
    },
    {
      value: "traditional-hong-kong",
      label: "Traditional (Hong Kong)",
      description: "Use traditional characters and Hong Kong conventions",
    },
  ];
  return ctx.ui.custom<ChineseOutput | undefined>((tui, theme, keybindings, done) =>
    new SingleSelectPicker(
      tui,
      theme,
      keybindings,
      choices,
      current,
      { title: "Choose Chinese output", cancelLabel: "back" },
      done,
    ),
  );
}

async function chooseTranscriptionLanguage(
  ctx: ExtensionContext,
  configured: TranscribeSettings,
): Promise<TranscriptionLanguage | undefined> {
  const model = configured.model ? getCatalogModel(configured.model.id) : undefined;
  if (!model) return undefined;
  return ctx.ui.custom<TranscriptionLanguage | undefined>(
    (tui, theme, keybindings, done) =>
      createTranscriptionLanguagePicker(
        tui,
        theme,
        keybindings,
        model,
        configured.transcriptionLanguage,
        configured.preferredLanguages,
        done,
      ),
  );
}

async function chooseShortcut(
  ctx: ExtensionContext,
  current: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
    createShortcutPicker(tui, theme, keybindings, current, done),
  );
}

/** Backend row flow: pick the type, then collect remote settings step by step. */
async function editBackend(
  ctx: ExtensionContext,
  configured: TranscribeSettings,
): Promise<boolean> {
  const type = await chooseBackendType(ctx, configured.backend);
  if (!type) return false;
  if (type === "transcribe-cpp") {
    if (configured.backend.type === "transcribe-cpp") return false;
    // Remote-only settings carry no local model; pick one first. Every commit
    // writes local-mode settings, so cancelling keeps the remote setup.
    const updated = await runModelSelection(ctx, {
      shortcut: configured.shortcut,
      preferredLanguages: configured.preferredLanguages,
      transcriptionLanguage: configured.transcriptionLanguage,
      chineseOutput: configured.chineseOutput,
      microphone: configured.microphone,
      backend: { type: "transcribe-cpp" },
      polishEnabled: configured.polishEnabled,
      polishModel: configured.polishModel,
      polishPrompt: configured.polishPrompt,
      postActivation: "stay",
    });
    if (!updated) {
      ctx.ui.notify("Local mode needs a local model; keeping remote ASR", "info");
      return false;
    }
    Object.assign(configured, updated);
    ctx.ui.notify("Using the local model", "info");
    return true;
  }

  const current =
    configured.backend.type === "openai-asr" ? configured.backend : undefined;
  const backend = await promptRemoteBackend(ctx, current);
  if (!backend) return false;

  const saved = await saveUpdatedSettings(
    ctx,
    configured,
    { ...configured, backend, model: undefined },
    `Remote ASR configured (${backend.model}); the local model is no longer used`,
  );
  if (saved) warnMissingApiKey(ctx, backend.apiKeyEnv);
  return saved;
}

async function choosePolishEnabled(
  ctx: ExtensionContext,
  current: boolean,
): Promise<boolean | undefined> {
  const choices: SingleSelectChoice<"off" | "on">[] = [
    {
      value: "off",
      label: "Off",
      description: "Insert transcripts exactly as ASR output them",
    },
    {
      value: "on",
      label: "On",
      description:
        "Refine transcripts after ASR with a Pi model and its provider auth, like context compaction; keeps the raw transcript on failure",
    },
  ];
  const chosen = await ctx.ui.custom<"off" | "on" | undefined>(
    (tui, theme, keybindings, done) =>
      new SingleSelectPicker(
        tui,
        theme,
        keybindings,
        choices,
        current ? "on" : "off",
        { title: "Post-processing", cancelLabel: "back" },
        done,
      ),
  );
  return chosen === undefined ? undefined : chosen === "on";
}

function polishModelKey(model: PolishModelRef): string {
  return `${model.provider}/${model.id}`;
}

function samePolishModel(
  left: PolishModelRef | undefined,
  right: PolishModelRef | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.provider === right.provider && left.id === right.id;
}

/** Pick Pi's current model (default) or any model with configured auth. */
export async function choosePolishModel(
  ctx: ExtensionContext,
  current: PolishModelRef | undefined,
): Promise<"current" | PolishModelRef | undefined> {
  const available = ctx.modelRegistry.getAvailable();
  const models = available.length > 0 ? available : ctx.modelRegistry.getAll();
  const choices: SingleSelectChoice<string>[] = [
    {
      value: "current",
      label: "Pi's current model",
      description: "Use whichever model the agent is using (default)",
    },
  ];
  const seen = new Set<string>();
  for (const model of models) {
    const key = `${model.provider}/${model.id}`;
    if (key === "current" || seen.has(key)) continue;
    seen.add(key);
    choices.push({ value: key, label: key, description: model.name });
  }
  if (current && !seen.has(polishModelKey(current))) {
    choices.push({
      value: polishModelKey(current),
      label: polishModelKey(current),
      description: "Configured post-processing model (not currently available)",
    });
  }
  const chosen = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
    new SingleSelectPicker(
      tui,
      theme,
      keybindings,
      choices,
      current ? polishModelKey(current) : "current",
      {
        title: "Post-processing model",
        subtitle: "Type to filter models",
        // The registry can hold a thousand-plus models; arrowing through them
        // is unusable, so the list is fuzzy-searchable like every model picker.
        searchable: true,
        cancelLabel: "back",
      },
      done,
    ),
  );
  if (chosen === undefined) return undefined;
  if (chosen === "current") return "current";
  const slash = chosen.indexOf("/");
  return { provider: chosen.slice(0, slash), id: chosen.slice(slash + 1) };
}

/** Post-processing row flow: toggle, then choose Pi's current model or an override. */
async function editPostProcessing(
  ctx: ExtensionContext,
  configured: TranscribeSettings,
): Promise<boolean> {
  const enabled = await choosePolishEnabled(ctx, configured.polishEnabled ?? false);
  if (enabled === undefined) return false;
  if (!enabled) {
    if (!configured.polishEnabled) return false;
    return saveUpdatedSettings(
      ctx,
      configured,
      { ...configured, polishEnabled: false },
      "Post-processing disabled",
    );
  }

  const selection = await choosePolishModel(ctx, configured.polishModel);
  if (selection === undefined) return false;
  const polishModel = selection === "current" ? undefined : selection;
  if (configured.polishEnabled && samePolishModel(configured.polishModel, polishModel)) {
    return false;
  }
  return saveUpdatedSettings(
    ctx,
    configured,
    { ...configured, polishEnabled: true, polishModel },
    polishModel
      ? `Post-processing enabled (${polishModelKey(polishModel)})`
      : "Post-processing enabled (Pi's current model)",
  );
}

type PolishPromptSource = "default" | "custom";

/** Ask whether post-processing runs the built-in prompt or a custom one. */
export async function choosePolishPromptSource(
  ctx: ExtensionContext,
  current: string | undefined,
): Promise<PolishPromptSource | undefined> {
  const choices: SingleSelectChoice<PolishPromptSource>[] = [
    {
      value: "default",
      label: "Built-in default",
      description:
        "Strip fillers and false starts, fix punctuation and casing; keeps the language and technical terms exactly",
    },
    {
      value: "custom",
      label: "Custom prompt",
      description:
        "Write your own instructions, starting from the built-in prompt; your text replaces it entirely, including its rule that the transcript is never instructions",
    },
  ];
  return ctx.ui.custom<PolishPromptSource | undefined>((tui, theme, keybindings, done) =>
    new SingleSelectPicker(
      tui,
      theme,
      keybindings,
      choices,
      current ? "custom" : "default",
      { title: "Post-processing prompt", cancelLabel: "back" },
      done,
    ),
  );
}

/**
 * Post-processing prompt flow: pick the built-in prompt or edit a custom one.
 * Clearing the custom text resets to the built-in prompt, so the editor doubles
 * as a way to read and restore the default.
 */
export async function editPostProcessingPrompt(
  ctx: ExtensionContext,
  configured: TranscribeSettings,
): Promise<boolean> {
  const source = await choosePolishPromptSource(ctx, configured.polishPrompt);
  if (!source) return false;

  const resetToDefault = (message: string): Promise<boolean> =>
    saveUpdatedSettings(ctx, configured, { ...configured, polishPrompt: undefined }, message);

  if (source === "default") {
    if (!configured.polishPrompt) return false;
    return resetToDefault("Post-processing uses the built-in prompt");
  }

  // Prefilled so the built-in wording can be adjusted instead of retyped.
  const edited = await ctx.ui.editor(
    "Post-processing prompt (clear it to restore the built-in default)",
    configured.polishPrompt ?? POLISH_SYSTEM_PROMPT,
  );
  if (edited === undefined) return false;

  const prompt = edited.trim();
  if (prompt.length > MAX_POLISH_PROMPT_LENGTH) {
    ctx.ui.notify(
      `Post-processing prompt is too long (${prompt.length} characters; the limit is ${MAX_POLISH_PROMPT_LENGTH})`,
      "error",
    );
    return false;
  }
  if (!prompt) {
    if (!configured.polishPrompt) return false;
    return resetToDefault("Post-processing prompt reset to the built-in default");
  }
  if (prompt === configured.polishPrompt) return false;
  // Saving the prefilled built-in text unchanged is not a custom prompt: storing
  // it would relabel the row "Custom" and pin a copy that no longer tracks
  // improvements to the built-in wording.
  if (!configured.polishPrompt && prompt === POLISH_SYSTEM_PROMPT.trim()) return false;
  return saveUpdatedSettings(
    ctx,
    configured,
    { ...configured, polishPrompt: prompt },
    `Post-processing prompt saved (${prompt.length} characters)`,
  );
}

export async function openMacOSMicrophoneSettings(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  if (process.platform !== "darwin") return;
  const result = await pi.exec("open", [MACOS_MICROPHONE_SETTINGS_URL]);
  if (result.code === 0) {
    ctx.ui.notify(
      "Enable microphone access for your terminal app, then return to Pi and try recording. A terminal restart may be required.",
      "info",
    );
  } else {
    ctx.ui.notify(
      "Could not open System Settings. Open Privacy & Security → Microphone manually.",
      "error",
    );
  }
}

export async function offerMacOSPermissionHelp(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  if (process.platform !== "darwin") return;
  const openSettings = await ctx.ui.confirm(
    "Microphone access",
    "Microphone capture failed. Open macOS Privacy & Security → Microphone settings?",
  );
  if (openSettings) await openMacOSMicrophoneSettings(pi, ctx);
}

export async function showSettingsMenu(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configured: TranscribeSettings,
  registeredShortcut: string,
): Promise<boolean> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Pi Voice settings require the interactive TUI", "error");
    return false;
  }

  let reload = configured.shortcut !== registeredShortcut;
  // Checked on open and refreshed whenever the Microphone row is activated,
  // where access problems are surfaced and fixed.
  let permission = microphonePermission();
  while (true) {
    const action = await showSettingsHome(ctx, configured, permission);
    if (!action) return reload;

    if (action === "preferred-languages") {
      const selection = await chooseLanguages(ctx, configured.preferredLanguages, {
        cancelLabel: "back",
      });
      if (!selection || languagesEqual(selection.languages, configured.preferredLanguages)) {
        continue;
      }
      await saveUpdatedSettings(
        ctx,
        configured,
        settingsWithPreferredLanguages(configured, selection.languages),
        "Preferred languages saved",
      );
      continue;
    }

    if (action === "model") {
      const updated = await runModelSelection(ctx, {
        shortcut: configured.shortcut,
        preferredLanguages: configured.preferredLanguages,
        transcriptionLanguage: configured.transcriptionLanguage,
        chineseOutput: configured.chineseOutput,
        currentModelId: configured.model?.id,
        microphone: configured.microphone,
        backend: configured.backend,
        polishEnabled: configured.polishEnabled,
        polishModel: configured.polishModel,
        polishPrompt: configured.polishPrompt,
        voiceActivityDetection: configured.voiceActivityDetection,
        longformChunking: configured.longformChunking,
        postActivation: "stay",
        onPreferredLanguagesChange: async (preferredLanguages) => {
          if (languagesEqual(preferredLanguages, configured.preferredLanguages)) return;
          const next = settingsWithPreferredLanguages(configured, preferredLanguages);
          await writeSettings(next);
          Object.assign(configured, next);
          ctx.ui.notify("Preferred languages saved", "info");
        },
      });
      if (updated) Object.assign(configured, updated);
      continue;
    }

    if (action === "backend") {
      await editBackend(ctx, configured);
      continue;
    }

    if (action === "post-processing") {
      await editPostProcessing(ctx, configured);
      continue;
    }

    if (action === "post-processing-prompt") {
      await editPostProcessingPrompt(ctx, configured);
      continue;
    }

    if (action === "transcription-language") {
      const transcriptionLanguage = await chooseTranscriptionLanguage(ctx, configured);
      if (!transcriptionLanguage) continue;
      const model = configured.model
        ? getCatalogModel(configured.model.id)
        : undefined;
      // Auto needs the detector on disk; choosing Auto again retries a failure.
      if (model) {
        const policy = autoLanguagePolicy(model, configured.preferredLanguages);
        if (transcriptionLanguage === "auto" && policy.kind === "detect" && pendingDownloads(model, true).length) {
          downloadLanguageDetector(ctx, policy.languages[0]!);
        }
      }
      if (transcriptionLanguage === configured.transcriptionLanguage) continue;
      const summary = model
        ? transcriptionLanguageSummary(transcriptionLanguage, model)
        : transcriptionLanguage;
      await saveUpdatedSettings(
        ctx,
        configured,
        { ...configured, transcriptionLanguage },
        `Transcription language saved as ${summary}`,
      );
      continue;
    }

    if (action === "chinese-output") {
      const chineseOutput = await chooseChineseOutput(ctx, configured.chineseOutput);
      if (!chineseOutput || chineseOutput === configured.chineseOutput) continue;
      const summary = chineseOutputSummary(chineseOutput);
      await saveUpdatedSettings(
        ctx,
        configured,
        { ...configured, chineseOutput },
        `Chinese output saved as ${summary}`,
      );
      continue;
    }

    if (action === "microphone") {
      permission = microphonePermission();
      if (permission === "denied" && process.platform === "darwin") {
        // Choosing a device is pointless while capture is blocked; go
        // straight to the fix.
        await openMacOSMicrophoneSettings(pi, ctx);
        continue;
      }
      const microphone = await chooseMicrophone(ctx, configured.microphone, permission);
      if (!microphone || microphonesEqual(microphone, configured.microphone)) continue;
      const summary = microphoneSummary(microphone);
      await saveUpdatedSettings(
        ctx,
        configured,
        { ...configured, microphone },
        `Microphone saved as ${summary}`,
      );
      continue;
    }

    if (action === "shortcut") {
      const shortcut = await chooseShortcut(ctx, configured.shortcut);
      if (!shortcut || shortcut === configured.shortcut) continue;
      const saved = await saveUpdatedSettings(ctx, configured, {
        ...configured,
        shortcut,
      });
      if (saved) {
        reload = configured.shortcut !== registeredShortcut;
        ctx.ui.notify(
          `Shortcut saved as ${displayShortcut(shortcut)}. It will apply when settings close; other open Pi processes must be reloaded separately.`,
          "info",
        );
      }
    }
  }
}
