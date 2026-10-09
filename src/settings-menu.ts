import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Input, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { microphonePermission, type Permission } from "./audio.js";
import { displayLanguage, getCatalogModel } from "./catalog.js";
import { chineseOutputSummary, isChineseLanguage } from "./chinese.js";
import { VoiceKeys } from "./keybindings.js";
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
import {
  writeSettings,
  type BackendSettings,
  type ChineseOutput,
  type MicrophoneSetting,
  type TranscribeSettings,
  type TranscriptionLanguage,
} from "./settings.js";
import { displayShortcut } from "./shortcut-core.js";
import { createShortcutPicker } from "./shortcuts.js";
import {
  LIST_PADDING,
  padToWidth,
  panelBorder,
  SingleSelectPicker,
  type SingleSelectChoice,
} from "./ui-components.js";

const MACOS_MICROPHONE_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
const SETTINGS_LABEL_WIDTH = 25;
// Text padding (2), cursor gutter (2), label column, and its gap (2).
const SETTINGS_ROW_OVERHEAD = SETTINGS_LABEL_WIDTH + 6;

type SettingsAction =
  | "preferred-languages"
  | "model"
  | "backend"
  | "transcription-language"
  | "chinese-output"
  | "microphone"
  | "shortcut";

type SettingsHomeChoice = SingleSelectChoice<SettingsAction> & {
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

function settingsHomeChoices(
  configured: TranscribeSettings,
  permission: Permission,
): SettingsHomeChoice[] {
  const model = getCatalogModel(configured.model.id)!;
  const choices: SettingsHomeChoice[] = [
    {
      value: "preferred-languages",
      label: "Preferred languages",
      summary: preferredLanguagesSummary(configured.preferredLanguages),
      description: "Languages you speak, used to rank and recommend transcription models",
    },
    {
      value: "model",
      label: "Model",
      summary: model.name,
      description: "Switch between downloaded models, or download a new one",
    },
    {
      value: "backend",
      label: "Transcription backend",
      summary: backendSummary(configured.backend),
      description:
        "Local model, or an OpenAI-compatible remote ASR endpoint (local model stays as fallback)",
    },
    {
      value: "transcription-language",
      label: "Transcription language",
      summary: transcriptionLanguageSummary(configured.transcriptionLanguage, model),
      description: "Language expected in recordings, or automatic detection when supported",
    },
  ];

  if (
    isChineseLanguage(configured.transcriptionLanguage) ||
    configured.preferredLanguages.some(isChineseLanguage)
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
  const model = getCatalogModel(configured.model.id)!;
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

/**
 * Single-field text prompt built on pi-tui's Input. Empty input may be legal
 * (the caller decides via validate); Escape backs out of the whole flow.
 */
function promptText(
  ctx: ExtensionContext,
  options: {
    title: string;
    description?: string;
    value: string;
    placeholder?: string;
    validate?: (value: string) => string | undefined;
  },
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const keys = new VoiceKeys(keybindings);
    const input = new Input();
    input.setValue(options.value);
    let error: string | undefined;
    const container = new Container();

    const rebuild = (): void => {
      container.clear();
      container.addChild(panelBorder(theme));
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("accent", theme.bold(options.title)), 1, 0));
      if (options.description) {
        container.addChild(new Text(theme.fg("muted", options.description), 1, 0));
      }
      container.addChild(new Spacer(1));
      if (error) {
        container.addChild(new Text(theme.fg("error", error), 1, 0));
        container.addChild(new Spacer(1));
      }
      if (!input.getValue() && options.placeholder) {
        container.addChild(new Text(theme.fg("dim", options.placeholder), 2, 0));
      }
      const inputBox = new Box(LIST_PADDING, 0);
      inputBox.addChild(input);
      container.addChild(inputBox);
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(
          `${keys.hint("tui.input.submit", "save")}  ${keys.hint("tui.select.cancel", "back")}`,
          1,
          0,
        ),
      );
      container.addChild(new Spacer(1));
      container.addChild(panelBorder(theme));
    };
    rebuild();

    input.onSubmit = (value) => {
      const problem = options.validate?.(value.trim());
      if (problem) {
        error = problem;
        rebuild();
        tui.requestRender();
        return;
      }
      done(value.trim());
    };
    input.onEscape = () => done(undefined);

    return {
      get focused() {
        return input.focused;
      },
      set focused(value: boolean) {
        input.focused = value;
      },
      render(width: number): string[] {
        return container
          .render(width)
          .map((line) => truncateToWidth(line, width, ""));
      },
      handleInput(data: string): void {
        input.handleInput(data);
      },
      invalidate(): void {
        container.invalidate();
      },
    };
  });
}

async function chooseBackendType(
  ctx: ExtensionContext,
  current: BackendSettings,
): Promise<"transcribe-cpp" | "openai-asr" | undefined> {
  const choices: SingleSelectChoice<"transcribe-cpp" | "openai-asr">[] = [
    {
      value: "transcribe-cpp",
      label: "Local model",
      description: "Transcribe fully on-device with the downloaded model; works offline",
    },
    {
      value: "openai-asr",
      label: "Remote ASR (OpenAI-compatible)",
      description:
        "Upload audio to any OpenAI-compatible chat-completions ASR endpoint; falls back to the local model if the request fails",
    },
  ];
  return ctx.ui.custom<"transcribe-cpp" | "openai-asr" | undefined>(
    (tui, theme, keybindings, done) =>
      new SingleSelectPicker(
        tui,
        theme,
        keybindings,
        choices,
        current.type,
        { title: "Transcription backend", cancelLabel: "back" },
        done,
      ),
  );
}

function validateBaseUrl(value: string): string | undefined {
  if (!value) return "Base URL is required";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "Base URL must start with http:// or https://";
    }
  } catch {
    return "Base URL must be a valid URL";
  }
  return undefined;
}

function validateEnvName(value: string): string | undefined {
  if (!value) return "Environment variable name is required";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return "Use a plain environment variable name, e.g. OPENAI_API_KEY";
  }
  return undefined;
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
    return saveUpdatedSettings(
      ctx,
      configured,
      { ...configured, backend: { type: "transcribe-cpp" } },
      "Using the local model",
    );
  }

  const current =
    configured.backend.type === "openai-asr" ? configured.backend : undefined;
  const baseUrl = await promptText(ctx, {
    title: "ASR base URL",
    description: "OpenAI-compatible endpoint root, without the /chat/completions path",
    value: current?.baseUrl ?? "",
    placeholder: "https://api.example.com/v1",
    validate: validateBaseUrl,
  });
  if (baseUrl === undefined) return false;

  const model = await promptText(ctx, {
    title: "ASR model",
    value: current?.model ?? "",
    placeholder: "whisper-1",
    validate: (value) => (value ? undefined : "Model name is required"),
  });
  if (model === undefined) return false;

  const apiKeyEnv = await promptText(ctx, {
    title: "API key environment variable",
    description: "The key itself is read from this variable at runtime; it is never stored in settings",
    value: current?.apiKeyEnv ?? "",
    placeholder: "OPENAI_API_KEY",
    validate: validateEnvName,
  });
  if (apiKeyEnv === undefined) return false;

  const backend: BackendSettings = { type: "openai-asr", baseUrl, model, apiKeyEnv };
  if (
    current &&
    current.baseUrl === baseUrl &&
    current.model === model &&
    current.apiKeyEnv === apiKeyEnv
  ) {
    return false;
  }
  const saved = await saveUpdatedSettings(
    ctx,
    configured,
    { ...configured, backend },
    `Remote ASR configured (${model})`,
  );
  if (saved && !process.env[apiKeyEnv]) {
    ctx.ui.notify(
      `${apiKeyEnv} is not set in Pi's environment; remote transcription will fall back to the local model until it is set`,
      "warning",
    );
  }
  return saved;
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
        { ...configured, preferredLanguages: selection.languages },
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
        currentModelId: configured.model.id,
        microphone: configured.microphone,
        backend: configured.backend,
        postActivation: "stay",
        onPreferredLanguagesChange: async (preferredLanguages) => {
          if (languagesEqual(preferredLanguages, configured.preferredLanguages)) return;
          const next = { ...configured, preferredLanguages };
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

    if (action === "transcription-language") {
      const transcriptionLanguage = await chooseTranscriptionLanguage(ctx, configured);
      if (
        !transcriptionLanguage ||
        transcriptionLanguage === configured.transcriptionLanguage
      ) {
        continue;
      }
      const model = getCatalogModel(configured.model.id)!;
      const summary = transcriptionLanguageSummary(transcriptionLanguage, model);
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
