import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DOC_FILE,
  FORMAT,
  GENERATOR,
  type Doc,
  loadDoc,
  saveDoc,
  sha256,
} from "../src/format.ts";

// ---------------------------------------------------------------------------
// sha256()
// ---------------------------------------------------------------------------

test("sha256() is deterministic for the same input", () => {
  assert.equal(sha256("hello world"), sha256("hello world"));
});

test("sha256() returns a lowercase hex string of length 64", () => {
  assert.match(sha256("hello world"), /^[0-9a-f]{64}$/);
});

test("sha256() matches the known SHA-256 digest of a fixed string", () => {
  assert.equal(
    sha256("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("sha256() produces different digests for different inputs", () => {
  assert.notEqual(sha256("abc"), sha256("abd"));
});

// ---------------------------------------------------------------------------
// loadDoc() / saveDoc()
// ---------------------------------------------------------------------------

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

test("loadDoc() on an empty directory returns a fresh { format, generator } doc", async () => {
  await withTempDir(async (dir) => {
    const doc = await loadDoc(dir);
    assert.deepEqual(doc, { format: FORMAT, generator: GENERATOR });
  });
});

test("loadDoc() throws when tale-align.json declares an unknown format", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, DOC_FILE),
      JSON.stringify({ format: "some-other-format/v9", generator: "x" }),
    );
    await assert.rejects(
      () => loadDoc(dir),
      /unknown format "some-other-format\/v9"/,
    );
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
