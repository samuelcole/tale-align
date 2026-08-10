import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorText } from "../src/anchorText.ts";
import { paragraphs } from "../src/paragraphs.ts";

// ---------------------------------------------------------------------------
// txt mode
// ---------------------------------------------------------------------------

test('anchorText() txt mode turns blank-line-separated blocks into <p id> inside <section id="text">', () => {
  const input = "First paragraph.\n\nSecond paragraph.";
  assert.equal(
    anchorText(input, "txt"),
    '<section id="text">\n' +
      '<p id="text-p1">First paragraph.</p>\n' +
      '<p id="text-p2">Second paragraph.</p>\n' +
      "</section>",
  );
});

test("anchorText() txt mode escapes &, <, > in block text", () => {
  const input = "A & B < C > D";
  assert.equal(
    anchorText(input, "txt"),
    '<section id="text">\n<p id="text-p1">A &amp; B &lt; C &gt; D</p>\n</section>',
  );
});

test("anchorText() txt mode collapses internal newlines within a block to spaces", () => {
  const input = "Line one\nLine two\nLine three";
  assert.equal(
    anchorText(input, "txt"),
    '<section id="text">\n<p id="text-p1">Line one Line two Line three</p>\n</section>',
  );
});

test("anchorText() txt mode drops leading and trailing blank blocks", () => {
  const input = "\n\n\nFirst.\n\nSecond.\n\n\n\n";
  assert.equal(
    anchorText(input, "txt"),
    '<section id="text">\n' +
      '<p id="text-p1">First.</p>\n' +
      '<p id="text-p2">Second.</p>\n' +
      "</section>",
  );
});

test("anchorText() txt mode numbers paragraphs sequentially starting at 1", () => {
  const input = "One.\n\nTwo.\n\nThree.";
  const out = anchorText(input, "txt");
  assert.match(out, /<p id="text-p1">One\.<\/p>/);
  assert.match(out, /<p id="text-p2">Two\.<\/p>/);
  assert.match(out, /<p id="text-p3">Three\.<\/p>/);
});

// ---------------------------------------------------------------------------
// html mode
// ---------------------------------------------------------------------------

test("anchorText() html mode returns input verbatim (byte-equal) when it already has p[id]", () => {
  const input =
    '<p id="foo">Weird   spacing preserved</p>\n<p>no id, left alone</p>';
  assert.equal(anchorText(input, "html"), input);
});

test("anchorText() html mode returns verbatim even when only SOME <p> tags carry an id", () => {
  const input = '<div><p id="only-one">Has an id</p><p>Does not</p></div>';
  assert.equal(anchorText(input, "html"), input);
});

test("anchorText() html mode bakes sequential text-pN ids onto <p> tags that have none", () => {
  const input = "<p>Hello there world.</p><p>Second para here.</p>";
  assert.equal(
    anchorText(input, "html"),
    '<section id="text">\n' +
      '<p id="text-p1">Hello there world.</p>' +
      '<p id="text-p2">Second para here.</p>\n' +
      "</section>",
  );
});

test('anchorText() html mode wraps in <section id="text"> when the input has no <section id>', () => {
  const input = "<p>Only paragraph.</p>";
  const out = anchorText(input, "html");
  assert.match(out, /^<section id="text">\n/);
  assert.match(out, /<\/section>$/);
});

test("anchorText() html mode does not add an extra wrapper when the input already has a <section id>", () => {
  const input = '<section id="chapter-1"><p>Hello there world.</p></section>';
  assert.equal(
    anchorText(input, "html"),
    '<section id="chapter-1"><p id="text-p1">Hello there world.</p></section>',
  );
});

test("anchorText() html mode ids follow document order", () => {
  const input = "<div><p>Alpha para.</p><span><p>Beta para.</p></span></div>";
  const out = anchorText(input, "html");
  assert.match(out, /<p id="text-p1">Alpha para\.<\/p>/);
  assert.match(out, /<p id="text-p2">Beta para\.<\/p>/);
});

// ---------------------------------------------------------------------------
// Composability with paragraphs() from ../src/paragraphs.ts
// ---------------------------------------------------------------------------

test("paragraphs(anchorText(txt)) yields the expected fragments", () => {
  const input = "\n\nFirst para here.\n\nHi\n\nThird para\nwrapped nicely.\n\n";
  // "Hi" is a single word, so paragraphs() drops it — its anchor id
  // (text-p2) is consumed but never appears in the output.
  assert.deepEqual(paragraphs(anchorText(input, "txt")), [
    ["text-p1", "First para here."],
    ["text-p3", "Third para wrapped nicely."],
  ]);
});

test("paragraphs(anchorText(html)) yields the expected fragments", () => {
  const input = "<p>Hello there world.</p><p>Solo</p><p>Second para here.</p>";
  // "Solo" is a single word, so paragraphs() drops it — its anchor id
  // (text-p2) is consumed but never appears in the output.
  assert.deepEqual(paragraphs(anchorText(input, "html")), [
    ["text-p1", "Hello there world."],
    ["text-p3", "Second para here."],
  ]);
});

test("paragraphs(anchorText(html)) is a no-op pass-through when the input is already anchored", () => {
  const input =
    '<p id="a">First anchored para</p><p id="b">Second anchored para</p>';
  assert.deepEqual(paragraphs(anchorText(input, "html")), [
    ["a", "First anchored para"],
    ["b", "Second anchored para"],
  ]);
});
