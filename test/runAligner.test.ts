import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
