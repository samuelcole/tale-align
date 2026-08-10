/**
 * The half of alignment that needs a machine: the audio on disk, the Python
 * aligner as a child process, and the durations that turn a catalog's
 * estimated runtimes into the real thing.
 *
 * Split out of ./core.ts, which is deliberately pure so a caller can import
 * the gate and the anchor extraction without pulling in a runtime. This file
 * is what the pure half refuses to be — `node:child_process`, a temp
 * directory, an `ffprobe` call — and every caller of it is somewhere that
 * genuinely has those: a one-off CLI run, a batch job over a catalog, a
 * sandbox spun up for one job. Keeping the seam here means a caller never has
 * to know that alignment is a Python process at all; it hands over text and
 * files and reads back times.
 *
 * The full word-by-word alignment — the granularity-agnostic archive a future
 * cut (coarser, finer, word-karaoke) re-derives from without a days-long
 * re-align — is just another field the worker emits. There is no
 * object-storage upload step here: the on-disk interchange document
 * (./format.ts) is the archive.
 *
 * The interpreter is ALIGN_PYTHON (default `python3`) — the aligner wants its
 * own venv, and where that venv is depends entirely on whose machine this is
 * running on; see worker/requirements.txt for what it needs.
 */

import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_UA, type Fragment, type WorkerOut } from "./core.ts";

const execFileAsync = promisify(execFile);

/** Path to the Python worker script, resolved relative to this module so it
 *  works the same whether this runs from src/ (ts-node, tests) or dist/ (the
 *  built package) — worker/ is a sibling of both. */
export function workerPath(): string {
  return path.join(import.meta.dirname, "..", "worker", "align_worker.py");
}

/** Run the Python aligner on a prepared job; resolve its parsed sync map.
 *  `stream` tells the worker to keep a giant's emission on disk (see
 *  STREAM_SECS in ./core.ts); `model` selects the acoustic backend —
 *  "wav2vec2" (MIT, English-only, the default: the whole default pipeline
 *  stays commercially clean) or "mms_fa" (Meta's multilingual aligner,
 *  CC-BY-NC 4.0, usually somewhat stronger — an explicit opt-in). Either
 *  way the weights auto-download from torchaudio's hosting on first use;
 *  none ship with this package. */
export function runAligner(
  frags: Fragment[],
  sections: string[],
  opts?: { python?: string; stream?: boolean; model?: string },
): Promise<WorkerOut> {
  const python = opts?.python ?? process.env.ALIGN_PYTHON ?? "python3";
  return new Promise((resolve, reject) => {
    const proc = spawn(python, [workerPath()], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let stdout = "";
    proc.stdout.on("data", (d) => {
      stdout += d;
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`aligner exited ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as WorkerOut);
      } catch {
        reject(new Error("aligner produced no valid sync map"));
      }
    });
    proc.stdin.write(
      JSON.stringify({
        frags,
        sections,
        stream: opts?.stream ?? false,
        model: opts?.model ?? "wav2vec2",
      }),
    );
    proc.stdin.end();
  });
}

/**
 * Pull one audio file down to a local path, patiently and under our own name.
 * `label` names the file in the error, since a section number means something
 * to a batch job and a job id means something to a single-request caller.
 */
export async function download(
  url: string,
  file: string,
  label: string,
  ua?: string,
): Promise<void> {
  const res = await fetch(url, {
    headers: { "user-agent": ua ?? DEFAULT_UA },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`audio HTTP ${res.status} for ${label}`);
  }
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
}

/** Exact duration of an audio file, via ffprobe — a catalog's advertised
 *  runtime is an estimate, and the whole-book timeline is cumulative over
 *  every section's duration, so rounding here would skew everything after it. */
export async function probeSecs(file: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    file,
  ]);
  const secs = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(secs)) {
    throw new Error(
      `ffprobe produced no readable duration for ${file}: ${stdout.trim() || "(empty output)"}`,
    );
  }
  return secs;
}
