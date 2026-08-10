import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { probeSecs, runAligner, workerPath } from "../src/worker.ts";

const execFileAsync = promisify(execFile);

async function mkAudioFixture(): Promise<{
  dir: string;
  mp3: string;
  png: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "worker-test-"));
  const mp3 = path.join(dir, "tiny.mp3");
  const png = path.join(dir, "tiny.png");
  await execFileAsync("ffmpeg", [
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-y",
    mp3,
  ]);
  // A real, ffprobe-readable file that nonetheless carries no duration:
  // ffprobe exits 0 on an image and prints "N/A" for format=duration, which
  // is exactly the path that should hit probeSecs' own explicit throw
  // (as opposed to a garbage/non-media file, which makes ffprobe itself
  // exit non-zero and fail earlier, with ffprobe's own error text).
  await execFileAsync("ffmpeg", [
    "-f",
    "lavfi",
    "-i",
    "color=c=red:size=16x16",
    "-frames:v",
    "1",
    "-y",
    png,
  ]);
  return { dir, mp3, png };
}

test("workerPath points at an existing worker/align_worker.py file", async () => {
  const p = workerPath();
  assert.ok(p.endsWith(path.join("worker", "align_worker.py")));
  const info = await stat(p);
  assert.ok(info.isFile());
});

test("probeSecs returns ~2 seconds for a 2-second ffmpeg-generated file", async () => {
  const { dir, mp3 } = await mkAudioFixture();
  try {
    const secs = await probeSecs(mp3);
    assert.ok(Math.abs(secs - 2) < 0.2, `expected ~2s, got ${secs}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("probeSecs rejects with its 'no readable duration' error when ffprobe finds no duration", async () => {
  const { dir, png } = await mkAudioFixture();
  try {
    await assert.rejects(() => probeSecs(png), /no readable duration/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
