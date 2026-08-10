import { test } from "node:test";
import assert from "node:assert/strict";
import { paragraphs } from "../src/paragraphs.ts";

test("paragraphs() extracts [id, text] pairs in document order", () => {
  const body =
    '<p id="p-z">First paragraph here</p><p id="p-a">Second paragraph here</p>';
  assert.deepEqual(paragraphs(body), [
    ["p-z", "First paragraph here"],
    ["p-a", "Second paragraph here"],
  ]);
});

test("paragraphs() strips inner tags from the paragraph text", () => {
  const body = '<p id="p1">Hello <em>brave</em> <strong>new</strong> world</p>';
  assert.deepEqual(paragraphs(body), [["p1", "Hello brave new world"]]);
});

test("paragraphs() decodes numeric entities", () => {
  const body = '<p id="p1">It&#8217;s a test</p>';
  assert.deepEqual(paragraphs(body), [["p1", "It’s a test"]]);
});

test("paragraphs() decodes &amp; &lt; &gt;", () => {
  const body = '<p id="p1">Fish &amp; chips &lt;tag&gt; end</p>';
  assert.deepEqual(paragraphs(body), [["p1", "Fish & chips <tag> end"]]);
});

test("paragraphs() replaces other named entities with a space", () => {
  const body = '<p id="p1">before &nbsp; and &mdash; after words</p>';
  // &nbsp; and &mdash; both collapse to whitespace, then whitespace itself
  // collapses, so this reads as one space-separated run.
  assert.deepEqual(paragraphs(body), [["p1", "before and after words"]]);
});

test("paragraphs() collapses whitespace runs (including newlines) to a single space", () => {
  const body = '<p id="p1">  lots   of\n\n  whitespace   here  </p>';
  assert.deepEqual(paragraphs(body), [["p1", "lots of whitespace here"]]);
});

test("paragraphs() drops paragraphs with fewer than 2 words", () => {
  const body =
    '<p id="empty"></p><p id="one-word">Solo</p><p id="two-words">Two words</p>';
  assert.deepEqual(paragraphs(body), [["two-words", "Two words"]]);
});

test("paragraphs() ignores <p> tags without an id attribute", () => {
  const body = '<p>No id, two words</p><p id="p1">Has id two words</p>';
  assert.deepEqual(paragraphs(body), [["p1", "Has id two words"]]);
});

test("paragraphs() returns an empty array when there are no anchored paragraphs", () => {
  assert.deepEqual(paragraphs("<div>no paragraphs at all</div>"), []);
});
