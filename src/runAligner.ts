/**
 * The half of alignment that needs a machine: the Python aligner as a child
 * process, spawned on a prepared job and read back as times.
 *
 * Split out of the pure modules (./gate.ts, ./paragraphs.ts) deliberately.
 * This file is what they refuse to be — `node:child_process`, a pipe, another
 * runtime entirely — and every caller of it is somewhere that genuinely has
 * those: a one-off CLI run, a batch job over a catalog, a sandbox spun up for
 * one job. Keeping the seam here means a caller never has to know that
 * alignment is a Python process at all; it hands over text and files and reads
 * back times.
 *
 * The full word-by-word alignment — the granularity-agnostic archive a future
 * cut (coarser, finer, word-karaoke) re-derives from without a days-long
 * re-align — is just another field the worker emits. There is no
 * object-storage upload step here: the on-disk interchange document
 * (./types/Doc.ts) is the archive.
 *
 * The interpreter comes from ./config.ts (`ALIGN_PYTHON`, default `python3`) —
 * the aligner wants its own venv, and where that venv is depends entirely on
 * whose machine this is running on; see requirements.txt for what it needs.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { text } from "node:stream/consumers";
import { config } from "./config.ts";
import { deepFreeze } from "./deepFreeze.ts";
import type { Fragment } from "./types/Fragment.ts";
import type { WorkerOut } from "./types/WorkerOut.ts";

/** Path to the Python worker script, resolved as a sibling of this module so
 *  it works the same whether this runs from src/ (the checkout, the tests) or
 *  dist/ (the built package) — the build copies align_worker.py next to the
 *  compiled JS precisely so this one join answers both. */
export function workerPath(): string {
  return path.join(import.meta.dirname, "align_worker.py");
}

/** Run the Python aligner on a prepared job; resolve its parsed sync map.
 *  `stream` tells the worker to keep a giant's emission on disk (see
 *  `config.streamSecs` in ./config.ts); `model` selects the acoustic backend —
 *  "wav2vec2" (MIT, English-only, the default: the whole default pipeline
 *  stays commercially clean) or "mms_fa" (Meta's multilingual aligner,
 *  CC-BY-NC 4.0, usually somewhat stronger — an explicit opt-in). Either
 *  way the weights auto-download from torchaudio's hosting on first use;
 *  none ship with this package. */
export async function runAligner(
  frags: Fragment[],
  sections: string[],
  opts?: { python?: string; stream?: boolean; model?: string },
): Promise<WorkerOut> {
  const python = opts?.python ?? config.python;
  const proc = spawn(python, [workerPath()], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  // Read stdout as one string rather than concatenating chunks — a sync map is
  // megabytes of UTF-8, and a multi-byte character split across two chunks
  // decodes correctly here and does not when Buffers are appended one by one.
  // A stream that dies takes the exit status' error, which says more.
  const collected = text(proc.stdout).catch(() => "");
  const exited = new Promise<void>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`aligner exited ${code}`));
      }
    });
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
  await exited;
  return deepFreeze(parseWorkerOut(await collected));
}

/** The worker's stdout, or the one error a caller can act on. */
function parseWorkerOut(stdout: string): WorkerOut {
  try {
    return JSON.parse(stdout) as WorkerOut;
  } catch {
    throw new Error("aligner produced no valid sync map");
  }
}
