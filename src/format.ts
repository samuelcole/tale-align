/**
 * The interchange document — tale-align's transport step (`tale-align.json`).
 *
 * One versioned JSON file accompanies a work directory through the pipeline:
 * `import` seeds it with the book and its anchored text, `fetch-audio` adds
 * the ordered audio sections, `align` adds the phrase/word timings, the gate
 * metrics, and the verdict. `export` only ever reads it. The document points
 * at its bulky neighbors (the text, the audio files) by relative path rather
 * than embedding them: the JSON is the map, the directory is the territory.
 *
 * The verdict travels with the data on purpose. An alignment that failed the
 * gates is still a useful record — "tried, refused, and here is which bar it
 * missed" — but a consumer must be able to honor the refusal. `export` does
 * (it will not emit an epub from a refused alignment without --force), and
 * any other consumer should. See FORMAT.md for the written spec.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { deepFreeze, type WorkerOut } from "./core.ts";

export const VERSION = "0.1.0";
export const FORMAT = "tale-align/v1";
export const GENERATOR = `tale-align/${VERSION}`;
export const DOC_FILE = "tale-align.json";

/** Where a text or a recording came from — enough to credit and re-fetch it. */
export type Source = { kind: string; id: string; url: string };

/** One audio file of the recording, in playing order. `secs` is the file's
 *  real duration (ffprobe), not a catalog estimate — the whole-book timeline
 *  is cumulative over these, so rounding here would skew every later clip. */
export type SectionEntry = {
  position: number;
  file: string;
  secs: number;
  title: string | null;
  reader: string | null;
};

/** The gate constants an alignment was judged against, recorded so a consumer
 *  reading the verdict can also read the bar it cleared (or missed). */
export type GateConstants = {
  minMedianConf: number;
  minCoverage: number;
  minDocCoverage: number;
  maxLeadS: number;
  maxTailS: number;
};

export type Verdict = {
  pass: boolean;
  docCoverage: number;
  /** The first gate that refused, in a sentence — null on a pass. */
  refusal: string | null;
  gates: GateConstants;
};

export type Doc = {
  format: typeof FORMAT;
  generator: string;
  book?: {
    title: string;
    author: string | null;
    language: string;
    source: Source;
  };
  text?: {
    /** Relative path to the anchored HTML (`<section id>` / `<p id>`). */
    file: string;
    sha256: string;
    paragraphs: number;
  };
  audio?: {
    source: Source;
    sections: SectionEntry[];
  };
  alignment?: {
    /** Acoustic backend the worker ran ("wav2vec2" | "mms_fa"). */
    model: string;
    alignedAt: string;
    /** Hash of the text the times were computed against — export refuses a
     *  mismatch, so an edited text can never ship yesterday's timings. */
    textSha256: string;
    phrases: WorkerOut["phrases"];
    words: WorkerOut["words"];
    meta: WorkerOut["meta"];
    verdict: Verdict;
  };
};

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Read a work directory's document, or start a fresh one if none exists yet.
 *  A file that exists but declares another format is an error, not a restart —
 *  silently clobbering someone's data is worse than asking them to look. The
 *  document comes back frozen: a stage that wants to add its half builds the
 *  next document from this one (`{ ...doc, audio }`) rather than editing it. */
export async function loadDoc(dir: string): Promise<Doc> {
  const file = path.join(dir, DOC_FILE);
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) {
    return deepFreeze({ format: FORMAT, generator: GENERATOR });
  }
  const doc = JSON.parse(raw) as Doc;
  if (doc.format !== FORMAT) {
    throw new Error(
      `${file}: unknown format "${doc.format}" (expected ${FORMAT})`,
    );
  }
  return deepFreeze(doc);
}

/** Compact on purpose: the words map for a novel runs to megabytes, and this
 *  file is a machine transport — FORMAT.md is the human-readable half. The
 *  generator stamp goes on the written document, not the caller's object. */
export async function saveDoc(dir: string, doc: Doc): Promise<void> {
  const stamped = { ...doc, generator: GENERATOR };
  await writeFile(path.join(dir, DOC_FILE), `${JSON.stringify(stamped)}\n`);
}
