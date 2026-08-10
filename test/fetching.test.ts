// The network seams, without the network: `fetch` is mocked, and the
// aligner's success path runs against a fake interpreter that speaks the
// worker's stdout contract. Everything here is behavior the other suites
// can't reach without touching gutenberg.org, archive.org, or torch.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchGutenbergEpub } from "../src/gutenberg.ts";
import { download, runAligner } from "../src/worker.ts";

function mockFetch(t: any, impl: (url: string, init?: RequestInit) => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) =>
    impl(String(input), init)) as typeof fetch;
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
  await assert.rejects(fetchGutenbergEpub("999999"), /no epub found for Gutenberg id 999999/);
});

test("runAligner() parses the worker's stdout JSON on a clean exit", async (t) => {
  // A stand-in interpreter: swallows the job from stdin, emits a minimal
  // WorkerOut — proving the spawn/stdin/stdout/parse plumbing end to end.
  const dir = await mkdtemp(path.join(tmpdir(), "ta-fake-py-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = path.join(dir, "fake-python");
  const out = {
    phrases: { "s-p1": [[0, 1.23, 0.9, 1]] },
    words: { "s-p1": [[1.23, "hello", 0.9]] },
    meta: {
      paras: 1,
      placed: 1,
      span_coverage: 1,
      lead_s: 1.2,
      tail_s: 0,
      phrases: 1,
      median_conf: 0.9,
      device: "test",
    },
  };
  await writeFile(
    fake,
    `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${JSON.stringify(out)}'\n`,
  );
  await chmod(fake, 0o755);
  const result = await runAligner([["s-p1", "hello world"]], ["/dev/null"], {
    python: fake,
  });
  assert.deepEqual(result.phrases["s-p1"], [[0, 1.23, 0.9, 1]]);
  assert.equal(result.meta.median_conf, 0.9);
});

test("runAligner() rejects when the worker emits no valid JSON", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ta-fake-py-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = path.join(dir, "fake-python");
  await writeFile(fake, "#!/bin/sh\ncat > /dev/null\necho not-json\n");
  await chmod(fake, 0o755);
  await assert.rejects(
    runAligner([["s-p1", "hello world"]], ["/dev/null"], { python: fake }),
    /no valid sync map/,
  );
});
