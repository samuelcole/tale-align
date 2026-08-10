// The network seam, without the network: `fetch` is mocked. Everything here
// is behavior the other suites can't reach without touching archive.org.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { download } from "../src/download.ts";

/** Swap `globalThis.fetch` for the duration of one test. Duplicated in
 *  fetchGutenbergEpub.test.ts — a dozen lines, and each suite stays readable
 *  on its own. */
function mockFetch(
  t: TestContext,
  impl: (url: string, init?: RequestInit) => Response,
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => impl(String(input), init)) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
}

test("download() writes the response bytes and sends a user-agent", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ta-fetch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let sentUa: string | undefined;
  mockFetch(t, (_url, init) => {
    sentUa = (init?.headers as Record<string, string>)?.["user-agent"];
    return new Response(Buffer.from("mp3-bytes"));
  });
  const file = path.join(dir, "a.mp3");
  await download("https://example.org/a.mp3", file, "section 1", "test-ua/1");
  assert.equal(await readFile(file, "utf8"), "mp3-bytes");
  assert.equal(sentUa, "test-ua/1");
});

test("download() names the label in its HTTP error", async (t) => {
  mockFetch(t, () => new Response(null, { status: 503 }));
  await assert.rejects(
    download("https://example.org/a.mp3", "/tmp/never-written", "section 7"),
    /audio HTTP 503 for section 7/,
  );
});
