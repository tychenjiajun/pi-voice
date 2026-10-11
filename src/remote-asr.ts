import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, Input, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { VoiceKeys } from "./keybindings.js";
import type { BackendSettings } from "./settings.js";
import {
  LIST_PADDING,
  panelBorder,
  SingleSelectPicker,
  type SingleSelectChoice,
} from "./ui-components.js";

export type BackendType = "transcribe-cpp" | "openai-asr";

/** Pick the transcription backend; shared by first-run setup and the settings menu. */
export async function chooseBackendType(
  ctx: ExtensionContext,
  current: BackendSettings,
): Promise<BackendType | undefined> {
  const choices: SingleSelectChoice<BackendType>[] = [
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
  return ctx.ui.custom<BackendType | undefined>((tui, theme, keybindings, done) =>
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

function remoteBackendsEqual(
  left: Extract<BackendSettings, { type: "openai-asr" }>,
  right: Extract<BackendSettings, { type: "openai-asr" }>,
): boolean {
  return (
    left.baseUrl === right.baseUrl &&
    left.model === right.model &&
    left.apiKeyEnv === right.apiKeyEnv
  );
}

/** Warn when the named variable is unset, so remote calls silently fall back to local. */
export function warnMissingApiKey(ctx: ExtensionContext, apiKeyEnv: string): void {
  if (process.env[apiKeyEnv]) return;
  ctx.ui.notify(
    `${apiKeyEnv} is not set in Pi's environment; remote transcription will fall back to the local model until it is set`,
    "warning",
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

/**
 * Collect base URL, model, and API key env var for an OpenAI-compatible ASR
 * endpoint. Returns undefined if the user backs out of any field. `current`
 * pre-fills the prompts when editing an existing backend.
 */
export async function promptRemoteBackend(
  ctx: ExtensionContext,
  current?: Extract<BackendSettings, { type: "openai-asr" }>,
): Promise<Extract<BackendSettings, { type: "openai-asr" }> | undefined> {
  const baseUrl = await promptText(ctx, {
    title: "ASR base URL",
    description: "OpenAI-compatible endpoint root, without the /chat/completions path",
    value: current?.baseUrl ?? "",
    placeholder: "https://api.example.com/v1",
    validate: validateBaseUrl,
  });
  if (baseUrl === undefined) return undefined;

  const model = await promptText(ctx, {
    title: "ASR model",
    value: current?.model ?? "",
    placeholder: "whisper-1",
    validate: (value) => (value ? undefined : "Model name is required"),
  });
  if (model === undefined) return undefined;

  const apiKeyEnv = await promptText(ctx, {
    title: "API key environment variable",
    description:
      "The key itself is read from this variable at runtime; it is never stored in settings",
    value: current?.apiKeyEnv ?? "",
    placeholder: "OPENAI_API_KEY",
    validate: validateEnvName,
  });
  if (apiKeyEnv === undefined) return undefined;

  const backend = { type: "openai-asr" as const, baseUrl, model, apiKeyEnv };
  if (current && remoteBackendsEqual(current, backend)) return undefined;
  return backend;
}
