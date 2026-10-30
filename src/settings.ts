import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import {
  languageIdentity,
  getCatalogModel,
  resolveModelLanguage,
  type CatalogModel,
} from "./catalog.js";
import { autoLanguagePolicy } from "./language-detection-policy.js";
import { normalizeShortcut } from "./shortcut-core.js";
import { legacySettingsPath, settingsPath } from "./settings-path.js";

const SETTINGS_VERSION = 1;

export type MicrophoneSetting =
  | { type: "system-default" }
  | { type: "device"; name: string; occurrence: number };

export const DEFAULT_MICROPHONE: MicrophoneSetting = { type: "system-default" };

export type ChineseOutput = "simplified" | "traditional-taiwan" | "traditional-hong-kong";

/**
 * Where recordings are transcribed. `transcribe-cpp` runs a local catalog
 * model; `openai-asr` uploads to any OpenAI-compatible chat-completions ASR
 * endpoint via the `input_audio` content block. The two are exclusive: remote
 * mode stores no local model, and local mode has no remote configuration.
 */
export type BackendSettings =
  | { type: "transcribe-cpp" }
  | { type: "openai-asr"; baseUrl: string; model: string; apiKeyEnv: string };

/**
 * Explicit model for post-processing, resolved through Pi's model registry and
 * its provider auth. Absent means the agent's current model.
 */
export type PolishModelRef = { provider: string; id: string };

function defaultChineseOutput(): ChineseOutput {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const subtags = locale.toLowerCase().split("-");
  if (subtags.includes("hk") || subtags.includes("mo")) return "traditional-hong-kong";
  if (subtags.includes("tw") || subtags.includes("hant")) return "traditional-taiwan";
  return "simplified";
}

/** "auto" uses native detection or the external detector; otherwise a language code. */
export type TranscriptionLanguage = string;

export type TranscribeSettings = {
  version: 1;
  backend: BackendSettings;
  shortcut: string;
  preferredLanguages: string[];
  transcriptionLanguage: TranscriptionLanguage;
  chineseOutput: ChineseOutput;
  microphone: MicrophoneSetting;
  /** Optional post-processing with Pi's current model; absent means disabled (backward compatible). */
  polishEnabled?: boolean;
  /** Optional post-processing model override; absent uses the agent's current model. */
  polishModel?: PolishModelRef;
  /** Optional post-processing instructions; absent uses the built-in prompt. */
  polishPrompt?: string;
  /** Transcribe only the speech in a recording, not its silence and noise. */
  voiceActivityDetection: boolean;
  /** Hidden, settings.json only: false decodes long audio in one piece, without voice activity cuts. */
  longformChunking: boolean;
  /**
   * The local catalog model. Present only in local mode (backend
   * `transcribe-cpp`); remote mode stores no local model.
   */
  model?: {
    source: "catalog";
    id: string;
    path: string;
  };
};

type SettingsReadResult = {
  settings?: TranscribeSettings;
  warning?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLanguages(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((language) => typeof language === "string")) {
    return undefined;
  }
  const languages = [...new Set(value.map(languageIdentity).filter(Boolean))];
  return languages.length > 0 ? languages : undefined;
}

function validateChineseOutput(value: unknown): ChineseOutput {
  return value === "simplified" ||
    value === "traditional-taiwan" ||
    value === "traditional-hong-kong"
    ? value
    : defaultChineseOutput();
}

function validateMicrophone(value: unknown): MicrophoneSetting | undefined {
  if (!isObject(value)) return undefined;
  if (value.type === "system-default") return { type: "system-default" };
  if (
    value.type !== "device" ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    !Number.isInteger(value.occurrence) ||
    (value.occurrence as number) < 0
  ) {
    return undefined;
  }
  return { type: "device", name: value.name, occurrence: value.occurrence as number };
}

function defaultTranscriptionLanguage(
  model: CatalogModel,
  preferredLanguages: readonly string[] = [],
): TranscriptionLanguage {
  if (autoLanguagePolicy(model, preferredLanguages).kind !== "unsupported") return "auto";
  for (const language of preferredLanguages) {
    const code = resolveModelLanguage(model, language);
    if (code) return code;
  }
  return model.languages[0] ?? "en";
}

/** Keep an exact model language when possible; otherwise choose a safe default. */
export function transcriptionLanguageForModel(
  value: unknown,
  model: CatalogModel,
  preferredLanguages: readonly string[] = [],
): TranscriptionLanguage {
  if (typeof value === "string") {
    if (value === "auto" && autoLanguagePolicy(model, preferredLanguages).kind !== "unsupported") {
      return value;
    }
    if (value !== "auto") {
      const code = resolveModelLanguage(model, value);
      if (code) return code;
    }
  }
  return defaultTranscriptionLanguage(model, preferredLanguages);
}

function validateBackend(value: unknown): BackendSettings | undefined {
  if (!isObject(value)) return undefined;
  if (value.type === "transcribe-cpp") return { type: "transcribe-cpp" };
  if (value.type === "openai-asr") {
    // Deliberately lenient here: settings are validated on every read, and a
    // slightly odd base URL should surface as a request error, not as "invalid
    // settings" that silently drops the whole configuration.
    if (typeof value.baseUrl !== "string" || !value.baseUrl.trim()) return undefined;
    if (typeof value.model !== "string" || !value.model.trim()) return undefined;
    if (
      typeof value.apiKeyEnv !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv.trim())
    ) {
      return undefined;
    }
    return {
      type: "openai-asr",
      baseUrl: value.baseUrl.trim(),
      model: value.model.trim(),
      apiKeyEnv: value.apiKeyEnv.trim(),
    };
  }
  return undefined;
}

function normalizePolishModel(value: unknown): PolishModelRef | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.provider !== "string" || !value.provider.trim()) return undefined;
  if (typeof value.id !== "string" || !value.id.trim()) return undefined;
  return { provider: value.provider.trim(), id: value.id.trim() };
}

/** A blank or non-string prompt means "use the built-in one", so it is dropped. */
function normalizePolishPrompt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const prompt = value.trim();
  return prompt ? prompt : undefined;
}

function validateModelValue(
  value: unknown,
): { id: string; path: string; catalogModel: CatalogModel } | undefined {
  if (!isObject(value) || value.source !== "catalog") return undefined;
  if (typeof value.id !== "string") return undefined;
  const catalogModel = getCatalogModel(value.id);
  if (!catalogModel) return undefined;
  if (typeof value.path !== "string" || value.path.length === 0) return undefined;
  return { id: value.id, path: value.path, catalogModel };
}

function validateSettings(value: unknown): TranscribeSettings | undefined {
  if (!isObject(value) || value.version !== SETTINGS_VERSION) return undefined;
  const backend = validateBackend(value.backend);
  if (!backend) return undefined;
  const shortcut =
    typeof value.shortcut === "string" ? normalizeShortcut(value.shortcut) : undefined;
  if (!shortcut) return undefined;

  const selected = validateModelValue(value.model);
  // Local mode needs a model; remote mode drops any leftover local model so
  // settings are ever either local-only or remote-only, never both.
  if (backend.type === "transcribe-cpp" && !selected) return undefined;

  const preferredLanguages = normalizeLanguages(value.preferredLanguages);
  const microphone = validateMicrophone(value.microphone);
  if (!preferredLanguages || !microphone) return undefined;
  const polishModel = normalizePolishModel(value.polishModel);
  const polishPrompt = normalizePolishPrompt(value.polishPrompt);

  // The remote endpoint detects the language itself; the stored language only
  // triggers Chinese script conversion, so any previous value is kept as-is.
  const transcriptionLanguage =
    backend.type === "openai-asr"
      ? typeof value.transcriptionLanguage === "string" && value.transcriptionLanguage
        ? value.transcriptionLanguage
        : "auto"
      : transcriptionLanguageForModel(
          value.transcriptionLanguage,
          selected!.catalogModel,
          preferredLanguages,
        );

  return {
    version: SETTINGS_VERSION,
    backend,
    shortcut,
    preferredLanguages,
    transcriptionLanguage,
    chineseOutput: validateChineseOutput(value.chineseOutput),
    microphone,
    polishEnabled: value.polishEnabled === true,
    ...(polishModel ? { polishModel } : {}),
    ...(polishPrompt ? { polishPrompt } : {}),
    voiceActivityDetection: value.voiceActivityDetection !== false,
    longformChunking: value.longformChunking !== false,
    ...(backend.type === "transcribe-cpp"
      ? { model: { source: "catalog" as const, id: selected!.id, path: selected!.path } }
      : {}),
  };
}

async function readSettingsFile(path: string): Promise<SettingsReadResult> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const settings = validateSettings(parsed);
    return settings
      ? { settings }
      : { warning: `Invalid settings in ${path}; configuration is required.` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return {
      warning: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function readSettings(): Promise<SettingsReadResult> {
  const currentPath = settingsPath();
  const current = await readSettingsFile(currentPath);
  if (current.settings || current.warning) return current;

  const legacyPath = legacySettingsPath();
  const legacy = await readSettingsFile(legacyPath);
  if (!legacy.settings) return legacy;

  try {
    await writeSettings(legacy.settings);
    await unlink(legacyPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return { settings: legacy.settings };
  } catch (error) {
    return {
      settings: legacy.settings,
      warning: `Loaded legacy settings from ${legacyPath}, but could not migrate them to ${currentPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function writeSettings(settings: TranscribeSettings): Promise<void> {
  const path = settingsPath();
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(settings, null, 2)}\n`;

  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

type ModelSettingsOptions = {
  shortcut: string;
  preferredLanguages?: readonly string[];
  transcriptionLanguage?: TranscriptionLanguage;
  chineseOutput?: ChineseOutput;
  microphone?: MicrophoneSetting;
  /**
   * Preserved across model re-selection when local; picking a model always
   * yields local-only settings, since the backends are exclusive.
   */
  backend?: BackendSettings;
  /** Preserved across model re-selection; defaults to disabled. */
  polishEnabled?: boolean;
  /** Preserved across model re-selection; absent means the agent's current model. */
  polishModel?: PolishModelRef;
  /** Preserved across model re-selection; absent means the built-in prompt. */
  polishPrompt?: string;
  voiceActivityDetection?: boolean;
  longformChunking?: boolean;
};

export function settingsForModel(
  modelId: string,
  modelPath: string,
  options: ModelSettingsOptions,
): TranscribeSettings {
  const model = getCatalogModel(modelId);
  if (!model) throw new Error(`Unknown catalog model: ${modelId}`);
  const preferredLanguages = [
    ...new Set((options.preferredLanguages ?? ["en"]).map(languageIdentity)),
  ];
  return {
    version: SETTINGS_VERSION,
    // Exclusive modes: a selected local model drops any remote configuration.
    backend:
      options.backend && options.backend.type === "transcribe-cpp"
        ? options.backend
        : { type: "transcribe-cpp" },
    shortcut: options.shortcut,
    preferredLanguages,
    transcriptionLanguage: transcriptionLanguageForModel(
      options.transcriptionLanguage,
      model,
      preferredLanguages,
    ),
    chineseOutput: options.chineseOutput ?? defaultChineseOutput(),
    microphone: { ...(options.microphone ?? DEFAULT_MICROPHONE) },
    polishEnabled: options.polishEnabled ?? false,
    ...(options.polishModel ? { polishModel: options.polishModel } : {}),
    ...(options.polishPrompt ? { polishPrompt: options.polishPrompt } : {}),
    voiceActivityDetection: options.voiceActivityDetection ?? true,
    longformChunking: options.longformChunking ?? true,
    model: { source: "catalog", id: modelId, path: modelPath },
  };
}


type RemoteSettingsOptions = Omit<ModelSettingsOptions, "backend"> & {
  backend: Extract<BackendSettings, { type: "openai-asr" }>;
};

/** Remote-only settings: no local model is stored, so the endpoint is the sole backend. */
export function settingsRemoteOnly(options: RemoteSettingsOptions): TranscribeSettings {
  const preferredLanguages = [
    ...new Set((options.preferredLanguages ?? ["en"]).map(languageIdentity)),
  ];
  return {
    version: SETTINGS_VERSION,
    backend: options.backend,
    shortcut: options.shortcut,
    preferredLanguages,
    // The endpoint detects the language itself; "auto" keeps the stored value
    // from triggering Chinese conversion against a language that is not there.
    transcriptionLanguage: options.transcriptionLanguage ?? "auto",
    chineseOutput: options.chineseOutput ?? defaultChineseOutput(),
    microphone: { ...(options.microphone ?? DEFAULT_MICROPHONE) },
    polishEnabled: options.polishEnabled ?? false,
    ...(options.polishModel ? { polishModel: options.polishModel } : {}),
    ...(options.polishPrompt ? { polishPrompt: options.polishPrompt } : {}),
    voiceActivityDetection: options.voiceActivityDetection ?? true,
    longformChunking: options.longformChunking ?? true,
  };
}

/** The configured transcription source: local model id, or the remote ASR model name. */
export function transcriptionModelLabel(settings: TranscribeSettings): string {
  if (settings.model) return settings.model.id;
  return settings.backend.type === "openai-asr" ? settings.backend.model : "none";
}

/** Preference edits re-resolve the language, so Auto never outlives support for it. */
export function settingsWithPreferredLanguages(
  current: TranscribeSettings,
  preferredLanguages: readonly string[],
): TranscribeSettings {
  // Remote settings carry no local model, so there is no per-model language to
  // re-resolve; the endpoint detects the language itself.
  if (!current.model) {
    return {
      ...current,
      preferredLanguages: [...new Set(preferredLanguages.map(languageIdentity))],
    };
  }
  return settingsForModel(current.model.id, current.model.path, { ...current, preferredLanguages });
}
