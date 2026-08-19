import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isPlaceholderTitle,
  maybeTitleFromTimeline,
  PLACEHOLDER_TITLE,
  titleFromUserPrompt,
} from "../../src/sessions/title.js";

describe("session title", () => {
  it("treats New chat / HelmCode as placeholders", () => {
    assert.equal(isPlaceholderTitle(undefined), true);
    assert.equal(isPlaceholderTitle(""), true);
    assert.equal(isPlaceholderTitle(PLACEHOLDER_TITLE), true);
    assert.equal(isPlaceholderTitle("HelmCode"), true);
    assert.equal(isPlaceholderTitle("Fix the login bug"), false);
  });

  it("uses the collapsed first line of the prompt", () => {
    assert.equal(
      titleFromUserPrompt("  Fix the\nfailing test  "),
      "Fix the failing test",
    );
  });

  it("truncates long prompts on a word boundary", () => {
    const long = "Please rewrite the entire networking stack so the iPad client stays in sync with the runner workspace after every git switch";
    const titled = titleFromUserPrompt(long, 40);
    assert.ok(titled.endsWith("…"));
    assert.ok(titled.length <= 41);
    assert.equal(titled.includes(" "), true);
  });

  it("names from the first user message, not the last", () => {
    const titled = maybeTitleFromTimeline(PLACEHOLDER_TITLE, [
      { role: "user", text: "Add dark mode" },
      { role: "assistant", text: "Sure" },
      { role: "user", text: "Also fix the tests" },
    ]);
    assert.equal(titled, "Add dark mode");
  });

  it("leaves a custom title alone", () => {
    assert.equal(
      maybeTitleFromTimeline("Sprint 12", [
        { role: "user", text: "Add dark mode" },
      ]),
      "Sprint 12",
    );
  });
});
