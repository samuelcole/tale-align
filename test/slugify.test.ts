import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.ts";

test("slugify() lowercases the input", () => {
  assert.equal(slugify("STAVE ONE"), "stave-one");
});

test("slugify() drops apostrophes without leaving a hyphen behind", () => {
  assert.equal(slugify("Marley's"), "marleys");
  assert.equal(slugify("Marley’s"), "marleys"); // curly apostrophe
});

test("slugify() collapses runs of non-alphanumeric characters to a single hyphen", () => {
  assert.equal(
    slugify("Stave One: A Ghost Story!!"),
    "stave-one-a-ghost-story",
  );
});

test("slugify() trims leading and trailing hyphens", () => {
  assert.equal(slugify("  --Hello--  "), "hello");
});
