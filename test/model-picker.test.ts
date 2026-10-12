import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { CatalogModel } from "../src/catalog.js";
import { CatalogModelPicker } from "../src/model-picker.js";
import { keybindings, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");

const activate = () => new Promise<{ path: string }>(() => {});

/** Read the private filtered-model list for assertions. */
function pickedModels(picker: CatalogModelPicker): CatalogModel[] {
  return (picker as unknown as { filtered: CatalogModel[] }).filtered;
}

/** The footer's raw text (uses testTheme so the count is plain text). */
function footerText(picker: CatalogModelPicker): string {
  return (picker as unknown as { footer: { text: string } }).footer.text;
}

function rows(picker: CatalogModelPicker): { type: string; model?: CatalogModel }[] {
  return (picker as unknown as { rows: { type: string; model?: CatalogModel }[] }).rows;
}

function selectedIndex(picker: CatalogModelPicker): number {
  return (picker as unknown as { selectedIndex: number }).selectedIndex;
}

test("fuzzy search finds models that exact word matching would miss", () => {
  const picker = new CatalogModelPicker(
    testTui(24), testTheme(), keybindings(), ["en"], undefined,
    () => {}, activate,
  );
  // "wspr" is not a contiguous substring of "whisper-medium", so the old
  // exact-word matcher would return zero results. Fuzzy matching finds all
  // four whisper models (plus Breeze-ASR-25, whose id also contains w,s,p,r
  // in order).
  for (const char of "wspr") picker.handleInput(char);
  const found = pickedModels(picker).map((model) => model.id);
  assert.ok(
    found.some((id) => id === "whisper-medium"),
    `fuzzy "wspr" should include whisper-medium, got: ${found.join(", ")}`,
  );
  assert.ok(
    found.some((id) => id === "whisper-large-v3"),
    `fuzzy "wspr" should include whisper-large-v3, got: ${found.join(", ")}`,
  );
  assert.ok(
    found.some((id) => id === "whisper-small"),
    `fuzzy "wspr" should include whisper-small, got: ${found.join(", ")}`,
  );
  assert.match(footerText(picker), /5\/27 matching models/);
  picker.dispose();
});

test("fuzzy search matches single tokens that exact matching would miss", () => {
  const picker = new CatalogModelPicker(
    testTui(24), testTheme(), keybindings(), ["en"], undefined,
    () => {}, activate,
  );
  // "pkrt" is not a substring of "parakeet" but fuzzy-matches it.
  for (const char of "pkrt") picker.handleInput(char);
  const found = pickedModels(picker).map((model) => model.id);
  assert.ok(
    found.some((id) => id === "parakeet-unified-en-0.6b"),
    `fuzzy "pkrt" should include parakeet-unified-en-0.6b, got: ${found.join(", ")}`,
  );
  assert.ok(
    found.some((id) => id === "parakeet-tdt-0.6b-v3"),
    `fuzzy "pkrt" should include parakeet-tdt-0.6b-v3, got: ${found.join(", ")}`,
  );
  picker.dispose();
});

test("fuzzy search with a rare word highlights the unique match first", () => {
  const picker = new CatalogModelPicker(
    testTui(24), testTheme(), keybindings(), ["en"], undefined,
    () => {}, activate,
  );
  // "turbo" appears in only one model's search text, so it should be the
  // sole result and highlighted at the top.
  for (const char of "turbo") picker.handleInput(char);
  const found = pickedModels(picker).map((model) => model.id);
  assert.deepEqual(found, ["whisper-large-v3-turbo"], `got: ${found.join(", ")}`);
  const allRows = rows(picker);
  const firstModel = allRows.find((row) => row.type === "model");
  assert.equal(firstModel?.model?.id, "whisper-large-v3-turbo");
  assert.equal(selectedIndex(picker), allRows.indexOf(firstModel!));
  picker.dispose();
});

test("typing a query keeps the cursor on the best match (first model row)", () => {
  const picker = new CatalogModelPicker(
    testTui(24), testTheme(), keybindings(), ["en"], undefined,
    () => {}, activate,
  );
  // Move the cursor down a few rows before searching.
  picker.handleInput("\x1b[B");
  picker.handleInput("\x1b[B");
  assert.ok(selectedIndex(picker) > 0, "cursor should have moved down");
  // Now type a search query. handleInput resets selectedIndex to 0 on each
  // keystroke, and refresh no longer chases a highlight while querying.
  for (const char of "turbo") picker.handleInput(char);
  // The cursor should be on the first model row (the best fuzzy match),
  // not on a section header.
  const allRows = rows(picker);
  const firstModelIndex = allRows.findIndex((row) => row.type === "model");
  assert.ok(firstModelIndex >= 0, "there should be model rows after searching");
  assert.equal(
    selectedIndex(picker), firstModelIndex,
    "cursor should be on the first model row (best match), not a section header",
  );
  picker.dispose();
});

test("pressing Esc clears the search and restores the full count", () => {
  const picker = new CatalogModelPicker(
    testTui(24), testTheme(), keybindings(), ["en"], undefined,
    () => {}, activate,
  );
  for (const char of "wspr") picker.handleInput(char);
  assert.match(footerText(picker), /5\/27 matching models/);
  // Esc with search text present clears the query.
  picker.handleInput("\x1b");
  assert.match(footerText(picker), /27 models/);
  // The full count is shown, but some models are folded behind the fold row
  // by default, so filtered has fewer than 27 entries.
  assert.ok(pickedModels(picker).length < 27);
  picker.dispose();
});

test("a non-matching query shows no results", () => {
  const picker = new CatalogModelPicker(
    testTui(24), testTheme(), keybindings(), ["en"], undefined,
    () => {}, activate,
  );
  for (const char of "zzzzz") picker.handleInput(char);
  assert.equal(pickedModels(picker).length, 0, "no models should match 'zzzzz'");
  assert.match(footerText(picker), /0\/27 matching models/);
  picker.dispose();
});
