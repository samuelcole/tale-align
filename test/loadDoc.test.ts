import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadDoc } from "../src/loadDoc.ts";
import { GENERATOR } from "../src/saveDoc.ts";
import { DOC_FILE, FORMAT } from "../src/types/Doc.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "tale-align-format-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
