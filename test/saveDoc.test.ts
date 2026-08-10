import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadDoc } from "../src/loadDoc.ts";
import { GENERATOR, saveDoc } from "../src/saveDoc.ts";
import { sha256 } from "../src/sha256.ts";
import { type Doc, FORMAT } from "../src/types/Doc.ts";

// Same small helper as loadDoc.test.ts — a round-trip needs a work directory
// on both sides of the split, and duplicating four lines beats a shared
// fixtures module for two callers.
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "tale-align-format-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("saveDoc()/loadDoc() round-trip a document through a work directory", async () => {
  await withTempDir(async (dir) => {
    const doc: Doc = {
      format: FORMAT,
      generator: GENERATOR,
      book: {
        title: "Test Book",
        author: "Test Author",
        language: "en",
        source: { kind: "gutenberg", id: "12345", url: "https://example.com" },
      },
      text: { file: "text.html", sha256: sha256("some text"), paragraphs: 42 },
    };
    await saveDoc(dir, doc);
    const loaded = await loadDoc(dir);
    assert.deepEqual(loaded, doc);
  });
});

test("saveDoc() always stamps the current GENERATOR, overwriting whatever was passed in", async () => {
  await withTempDir(async (dir) => {
    const doc = {
      format: FORMAT,
      generator: "some-stale-generator/0.0.1",
    } as Doc;
    await saveDoc(dir, doc);
    const loaded = await loadDoc(dir);
    assert.equal(loaded.generator, GENERATOR);
    // The stamp goes on the written document only — the caller's object is
    // not mutated (it once was; a test caught it).
    assert.equal(doc.generator, "some-stale-generator/0.0.1");
  });
});
