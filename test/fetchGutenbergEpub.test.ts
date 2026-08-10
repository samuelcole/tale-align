// The network seam, without the network: `fetch` is mocked. Everything here
// is behavior the other suites can't reach without touching gutenberg.org.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fetchGutenbergEpub } from "../src/fetchGutenbergEpub.ts";

/** Swap `globalThis.fetch` for the duration of one test. Duplicated in
 *  download.test.ts — a dozen lines, and each suite stays readable on its
 *  own. */
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

test("fetchGutenbergEpub() falls back from the -images edition to the plain one", async (t) => {
  const tried: string[] = [];
  mockFetch(t, (url) => {
    tried.push(url);
    return url.endsWith("-images.epub")
      ? new Response(null, { status: 404 })
      : new Response(Buffer.from("epub-bytes"));
  });
  const buf = await fetchGutenbergEpub("46");
  assert.equal(buf.toString("utf8"), "epub-bytes");
  assert.ok(tried[0].endsWith("/46/pg46-images.epub"));
  assert.ok(tried[1].endsWith("/46/pg46.epub"));
});

test("fetchGutenbergEpub() throws when neither edition exists", async (t) => {
  mockFetch(t, () => new Response(null, { status: 404 }));
  await assert.rejects(
    fetchGutenbergEpub("999999"),
    /no epub found for Gutenberg id 999999/,
  );
});
