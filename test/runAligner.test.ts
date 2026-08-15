import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runAligner, workerPath } from "../src/runAligner.ts";

// Resolved as a sibling of the module that spawns it, so this reads src/ from
// the checkout and dist/ from the built package (the build copies it in).
test("workerPath points at an existing src/align_worker.py file", async () => {
  const p = workerPath();
  assert.ok(p.endsWith(path.join("src", "align_worker.py")));
  const info = await stat(p);
  assert.ok(info.isFile());
});

test("runAligner rejects when the python interpreter does not exist", async () => {
  await assert.rejects(
    () => runAligner([], [], { python: "/nonexistent/python" }),
    /ENOENT/,
  );
});

test("runAligner rejects with 'aligner exited' when the interpreter exits non-zero", async () => {
  // Running node against the .py file exercises the real spawn/stdin/stdout
  // plumbing without needing the actual (torch-dependent) aligner: node
  // can't parse Python and exits non-zero, which is exactly the failure
  // path runAligner is supposed to surface as "aligner exited <code>".
  await assert.rejects(
    () => runAligner([], [], { python: "node" }),
    /aligner exited/,
  );
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

/** Run the aligner against a stand-in interpreter that parks the job it was
 *  handed on disk — the only way to read what runAligner actually wrote to the
 *  worker's stdin, which is the whole contract between the two runtimes. */
async function jobSentWith(
  dir: string,
  opts: Parameters<typeof runAligner>[2],
): Promise<Record<string, unknown>> {
  const fake = path.join(dir, "fake-python");
  const parked = path.join(dir, "job.json");
  const out = { phrases: {}, words: {}, meta: {} };
  await writeFile(
    fake,
    `#!/bin/sh\ncat > '${parked}'\nprintf '%s' '${JSON.stringify(out)}'\n`,
  );
  await chmod(fake, 0o755);
  await runAligner([["s-p1", "hello world"]], ["/dev/null"], {
    ...opts,
    python: fake,
  });
  return JSON.parse(await readFile(parked, "utf8"));
}

// A book aligned before `language` existed was aligned as English, and English
// is the one rule that must never move: a stored sync map is read back by
// re-tokenizing the same text in the consumer's runtime, so a silent change
// here would slide every highlight in the catalog.
test("runAligner defaults the job's language to English", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ta-fake-py-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const job = await jobSentWith(dir, {});
  assert.equal(job.language, "en");
  assert.equal(job.model, "wav2vec2");
  assert.equal(job.stream, false);
});

test("runAligner sends the primary subtag of the caller's language", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ta-fake-py-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // An epub's dc:language is often region- or case-tagged; the worker's rules
  // are keyed on the one word, so the tag is reduced before it crosses.
  assert.equal((await jobSentWith(dir, { language: "fr" })).language, "fr");
  assert.equal((await jobSentWith(dir, { language: "fr-FR" })).language, "fr");
  assert.equal((await jobSentWith(dir, { language: "FR" })).language, "fr");
  assert.equal((await jobSentWith(dir, { language: "" })).language, "en");
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
