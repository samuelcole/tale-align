/**
 * The pipeline's operational knobs, in one place, read from the environment
 * once at load. These are decisions about *how a machine runs a job* — where
 * the Python lives, how much RAM to trust, whose name is on the bandwidth —
 * as opposed to the gates in ./gate.ts, which are deliberately NOT here: a
 * gate is part of the format's promise, and an env var that quietly changed
 * what "pass" means would betray every verdict already written.
 *
 * `config` is the snapshot this process runs with; `configFrom` is the pure
 * derivation, exported so a test (or a caller with its own env source) can
 * build one without touching `process.env`. Per-call overrides stay where
 * they are — `download(url, file, label, ua)`, `runAligner(…, { python })` —
 * config only supplies the defaults beneath them.
 *
 * The version comes from package.json at runtime — the one place it exists —
 * so nothing here (the UA string included) can drift when a release bumps it.
 */

import { createRequire } from "node:module";
import { deepFreeze } from "./deepFreeze.ts";

const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

/** The package version, straight from package.json. */
export const VERSION: string = version;

export type Config = {
  /** Interpreter for the aligner worker (`ALIGN_PYTHON`; default `python3`) —
   *  the aligner wants its own venv, and where that venv is depends entirely
   *  on whose machine this is. */
  python: string;
  /**
   * Above this many seconds of audio, the worker streams its emission to a
   * disk memmap instead of holding it in RAM — otherwise a 20h+ book's whole
   * emission plus its phase-1 search exhausts memory and the OS kills it (An
   * Autobiography, 21.8h, used to climb for an hour then die). Streaming is
   * somewhat slower per book, so only the giants pay it. The default, 54000s
   * (15h), is twice the longest book that aligns comfortably in 16GB;
   * `TALE_ALIGN_STREAM_SECS` tunes it to the machine's actual memory.
   */
  streamSecs: number;
  /** User-agent for every fetch against a shared public resource
   *  (gutenberg.org, librivox.org, archive.org) — override with
   *  `TALE_ALIGN_UA` to put your own name and contact on your traffic. */
  ua: string;
};

export function configFrom(env: Record<string, string | undefined>): Config {
  const streamSecs = Number(env.TALE_ALIGN_STREAM_SECS);
  return {
    python: env.ALIGN_PYTHON || "python3",
    streamSecs:
      Number.isFinite(streamSecs) && streamSecs > 0 ? streamSecs : 54_000,
    ua:
      env.TALE_ALIGN_UA ||
      `tale-align/${VERSION} (+https://github.com/samuelcole/tale-align)`,
  };
}

export const config: Config = deepFreeze(configFrom(process.env));
