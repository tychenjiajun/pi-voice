import type { ChineseOutput } from "./settings.js";

type Converter = (text: string) => string;

const converters = new Map<ChineseOutput, Promise<Converter>>();

async function createConverter(output: ChineseOutput): Promise<Converter> {
  const { default: OpenCC } = await import("opencc-js");
  switch (output) {
    case "simplified":
      return OpenCC.Converter({ from: "t", to: "cn" });
    case "traditional-taiwan":
      return OpenCC.Converter({ from: "cn", to: "tw" });
    case "traditional-hong-kong":
      return OpenCC.Converter({ from: "cn", to: "hk" });
  }
}

function converterFor(output: ChineseOutput): Promise<Converter> {
  const existing = converters.get(output);
  if (existing) return existing;

  const loading = createConverter(output);
  converters.set(output, loading);
  void loading.catch(() => {
    if (converters.get(output) === loading) converters.delete(output);
  });
  return loading;
}

export function isChineseLanguage(language: string): boolean {
  const base = language.toLowerCase().split("-", 1)[0];
  return base === "zh" || base === "yue";
}

/**
 * CJK ranges worth converting: Ext A, the main block, compatibility ideographs,
 * and Ext B+ (surrogate pairs are matched by their lead code unit).
 */
const HAN_CHARACTERS = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ud840-\ud87f]/;

/**
 * Remote ASR reports no detected language, so Chinese output is decided by
 * looking at the transcript: OpenCC is only worth loading when there is Han
 * text (or the configured language is Chinese) to convert.
 */
export function containsChineseCharacters(text: string): boolean {
  return HAN_CHARACTERS.test(text);
}

export async function convertChineseOutput(
  text: string,
  output: ChineseOutput,
): Promise<string> {
  return (await converterFor(output))(text);
}

export function chineseOutputSummary(output: ChineseOutput): string {
  switch (output) {
    case "simplified":
      return "Simplified";
    case "traditional-taiwan":
      return "Traditional (Taiwan)";
    case "traditional-hong-kong":
      return "Traditional (Hong Kong)";
  }
}
