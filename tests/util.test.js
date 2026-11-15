import assert from "node:assert/strict";
import test from "node:test";
import { loadContentNamespace } from "./load-content.js";

const { util } = loadContentNamespace(["util.js"]);

test("a no-break space, a thin space and a zero-width space are whitespace", () => {
  assert.equal(util.isWhitespace("\u00A0"), true);
  assert.equal(util.isWhitespace("\u202F"), true);
  assert.equal(util.isWhitespace("\u2009"), true);
  assert.equal(util.isWhitespace("\u3000"), true);
  assert.equal(util.isWhitespace("\u200B"), true);
  assert.equal(util.isWhitespace(" "), true);
  assert.equal(util.isWhitespace("\n"), true);
});

test("a letter is not whitespace, and a soft hyphen is silent rather than a space", () => {
  assert.equal(util.isWhitespace("a"), false);
  assert.equal(util.isWhitespace("\u00AD"), false);
  assert.equal(util.isSilent("\u00AD"), true);
  assert.equal(util.isSilent("\u200E"), true);
  assert.equal(util.isSilent("\uFEFF"), true);
  assert.equal(util.isSilent("\uFFFC"), true);
  assert.equal(util.isSilent("\u200D"), false, "a zero-width joiner holds an emoji together");
  assert.equal(util.isSilent("a"), false);
});

test("a line separator is a break, and a newline is the space HTML already makes of it", () => {
  assert.equal(util.isLineBreak("\u2028"), true);
  assert.equal(util.isLineBreak("\u2029"), true);
  assert.equal(util.isLineBreak("\n"), false);
  assert.equal(util.isWhitespace("\u2028"), false);
});
