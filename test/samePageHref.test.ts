import { test } from "node:test";
import assert from "node:assert/strict";
import { samePageHref } from "../src/samePageHref.ts";

test("samePageHref() keeps a fragment target on a cross-file link", () => {
  assert.equal(samePageHref("chapter5.xhtml#note3"), "#note3");
});

test("samePageHref() falls back to the file's basename when there is no fragment", () => {
  assert.equal(samePageHref("notes.xhtml"), "#notes");
});

test("samePageHref() strips .html and .htm the same as .xhtml", () => {
  assert.equal(samePageHref("notes.html"), "#notes");
  assert.equal(samePageHref("notes.htm"), "#notes");
});

test("samePageHref() strips a directory path down to the basename", () => {
  assert.equal(samePageHref("text/notes.xhtml"), "#notes");
});

test("samePageHref() leaves an already-same-page hash untouched", () => {
  assert.equal(samePageHref("#already"), "#already");
});

test("samePageHref() leaves absolute http(s) and mailto links untouched", () => {
  assert.equal(samePageHref("https://example.com/x"), "https://example.com/x");
  assert.equal(samePageHref("mailto:a@b.com"), "mailto:a@b.com");
});
