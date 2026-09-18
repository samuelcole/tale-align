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
 *
 * `FORMAT` and `DOC_FILE` live here rather than beside the reader and writer
 * because they are part of the type, not of the I/O: `Doc["format"]` is
 * literally `typeof FORMAT`, and `DOC_FILE` is the filename this shape is
 * always stored under. The runtime provenance stamp (`GENERATOR`) is a
 * different thing and lives with the writer that applies it, ./saveDoc.ts.
 */

import type { WorkerOut } from "./WorkerOut.ts";

export const FORMAT = "tale-align/v1";
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
  maxEndGap: number;
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
    /** The language rule the words were normalized under (a BCP-47 primary
     *  subtag). Optional: a document written before this field existed was
     *  aligned as English, which is what its absence means. A consumer that
     *  re-derives the word cut from the text — a browser highlighting along,
     *  an exporter re-splitting phrases — has to normalize it the same way or
     *  land a word off, so this records which way. */
    language?: string;
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
