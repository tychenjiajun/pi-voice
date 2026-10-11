import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  paneRowBudget,
  selectedWindow,
  SingleSelectPicker,
  windowSizeForBudget,
} from "../src/ui-components.js";
import { keybindings, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");

test("pane sizing reserves host rows and centers the selected window", () => {
  assert.equal(paneRowBudget(testTui(24)), 22);
  assert.equal(paneRowBudget(testTui()), undefined);
  assert.equal(windowSizeForBudget(5, 10), 5);
  assert.equal(windowSizeForBudget(20, 10), 10);
  assert.deepEqual(selectedWindow(Array.from({ length: 20 }), 10, 5), [8, 13]);
});

test("single select can show the onboarding progress header", () => {
  const picker = new SingleSelectPicker(
    testTui(24),
    testTheme(),
    keybindings(),
    [
      { value: "local", label: "Local model" },
      { value: "remote", label: "Remote ASR" },
    ],
    undefined,
    { title: "Pi Voice setup", onboardingStep: 1 },
    () => {},
  );
  const rendered = picker.render(80).join("\n");
  assert.match(rendered, /Pi Voice setup/);
  assert.match(rendered, /1 of 4/);
});
