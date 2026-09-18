/**
 * The gate that decides whether a read-along ships. One promise, one file.
 *
 * Different callers drive the same alignment — a one-off CLI run, a batch job
 * over a whole catalog, an app that hands a job to a sandboxed worker. They
 * differ in everything around the alignment — one plans a corpus and remembers
 * its failures, one leases a job and emails a verdict, one lives inside a
 * request — and in nothing about the alignment itself. That is the whole
 * reason this module exists: a gate that lives in two places is a gate that
 * eventually disagrees with itself, and the disagreement is invisible (both
 * sides look right; only the corpus knows). One promise — "a read-along ships
 * only when it's trustworthy" — has to be one function.
 *
 * **Pure on purpose.** Nothing here spawns a process, touches a filesystem, or
 * reaches the network. The half that does — the aligner spawn, the audio
 * download, the ffprobe call — lives apart (./runAligner.ts, ./download.ts,
 * ./probeSecs.ts) precisely so a caller can import the gate without dragging
 * `node:child_process` into its bundle. If something here ever needs an env
 * var or a driver, it belongs over there.
 */

import type { WorkerOut } from "./types/WorkerOut.ts";

/**
 * The read-along gate — a recording ships only when it clears every bar.
 *
 * `MIN_MEDIAN_CONF`: the median placed paragraph must be confidently aligned —
 * separates clean books (Dracula ~0.94) from mis-aligned ones (~0.6).
 *
 * `MIN_COVERAGE`: and most of the *narrated* text must be placed — coverage over
 * the span between the first and last placed paragraph, not the whole document.
 * That's the difference between text-only and shipping for a book with un-read
 * apparatus: Beowulf's narrator reads the 86 verse paragraphs but skips the
 * translator's preface, introduction and endnotes, so it's 61% of the document
 * yet ~100% of what's actually read. Whole-document coverage wrongly failed it.
 *
 * `MAX_LEAD_S`: but the narration's own opening must align — the first placed
 * paragraph near the audio's start. A big lead means content that IS narrated
 * didn't lock (read-along would start minutes in, nothing lit before), which
 * coverage-over-a-span can't see; this is what actually keeps a genuinely
 * broken opening out. ~2 min absorbs a recording's own intro and a section
 * title without letting a real gap through. The opening is where the aligner's
 * first lock is least certain, so this bar stays.
 *
 * `MAX_END_GAP`: and the narration must reach both ends of the *narrative* —
 * start within its opening 5% of paragraphs, stop within its closing 5%.
 * Paragraph coverage cannot tell a narrator who skipped the endnotes from a
 * recording of volume one: Emma's reader skips 58 endnotes and places 97%,
 * The Idiot's stops at 51% with everything before it placed. Where the
 * narration stops in the narrative can. "Narrative" matters: the worker
 * leaves apparatus — endnotes, appendices, prefaces, dedications, cast lists
 * — out of the measure, because that is what a narrator legitimately skips
 * and it sits exactly at the ends (Beowulf's translator's preface and
 * endnotes, again). Measured over tale.fyi's 916 shipped read-alongs
 * (2026-09-17): the unread tails were endnotes in 49 books and volume two in
 * one.
 *
 * There is no tail gate any more. Audio after the last placed paragraph, once
 * the narration is known to reach the narrative's end, is an appendix, a
 * sequel or a closing credit — Machiavelli's letters after The Prince,
 * Typee's sequel — and refusing the book for it cost 18 books that aligned
 * at 0.91–0.97. `tail_s` is still reported, for the log; a player simply
 * stops with the text.
 *
 * And the gate refuses to *judge* output that lacks the ends measure rather
 * than falling back to the old tail rule. Every path that runs the worker is
 * ours — the laptop backfill, the CLI, the sandbox image the hosted path
 * bakes it into — so a worker older than this gate is a deployment mistake,
 * and a mistake should fail at the first book, loudly, not change verdicts
 * quietly until someone notices.
 *
 * `lead_s` arrives already discounted for whole leading sections that placed
 * nothing (see align_worker.py): a dramatic reading's cast list is narrated,
 * correctly absent from the book, and correctly locks nothing — counting it
 * here would be the exact inverse of what this bar is for. An intro *inside*
 * the first placed section still counts in full, so the broken opening this
 * catches is still caught.
 *
 * `MIN_DOC_COVERAGE`: span-coverage has a blind spot the ends-gate misses. When
 * phase 1 locks only a small stretch of a book — a book placed only the first
 * ~10% of its paragraphs, smeared confidently across the whole audio at the
 * wrong times — span_coverage reads ~100% (that little stretch is fully
 * placed), lead/tail are small, and the median is high, so it ships a
 * read-along that's 90% missing and mistimed where present. Confidence doesn't
 * catch it (the model is confidently wrong), and no gap- or rate-based metric
 * separates it from a legitimately sparse book. So require, additionally, that
 * a real fraction of the *whole document* be placed. Judged books split
 * cleanly at ~0.5: the misfires cluster at 0.09–0.45 (short story collections
 * and novels the aligner barely locked), then a gap up to Beowulf at 0.61
 * (legit — it skips its apparatus) and beyond. Nothing sits between 0.45 and
 * 0.61, so 0.5 costs no good book.
 */
export const MIN_MEDIAN_CONF = 0.8;
export const MIN_COVERAGE = 0.9;
export const MIN_DOC_COVERAGE = 0.5;
// Keep the intended ~2-minute ceiling, with five seconds for MP3 frame
// rounding and a final spoken title/credit before the book text begins.
export const MAX_LEAD_S = 125;
export const MAX_END_GAP = 0.05;

/**
 * The worker's own measure of where the narration starts and stops in the
 * narrative. A worker that placed nothing reports null for both, and a book
 * that placed nothing fails every other bar anyway, so that reads as the
 * worst case; a worker that reports neither field at all predates this gate.
 */
function endGaps(meta: WorkerOut["meta"]): { start: number; end: number } {
  if (meta.start_gap === undefined || meta.end_gap === undefined) {
    throw new Error(
      "worker output has no start_gap/end_gap: the aligner predates gate 0.6.0 " +
        "— rebuild whatever ran it (the sandbox image?) with the current tale-align",
    );
  }
  return { start: meta.start_gap ?? 1, end: meta.end_gap ?? 1 };
}

/**
 * The verdict, in one place. `docCoverage` comes back with it because every
 * caller wants to say the number out loud — a batch job in its log line, an
 * app in the sentence it shows a user — and re-deriving it at each call site
 * is how the gate and the explanation drift apart.
 */
export function judge(meta: WorkerOut["meta"]): {
  pass: boolean;
  docCoverage: number;
} {
  const docCoverage = meta.placed / meta.paras;
  const gaps = endGaps(meta);
  return {
    pass:
      meta.median_conf >= MIN_MEDIAN_CONF &&
      meta.span_coverage >= MIN_COVERAGE &&
      docCoverage >= MIN_DOC_COVERAGE &&
      meta.lead_s <= MAX_LEAD_S &&
      gaps.start <= MAX_END_GAP &&
      gaps.end <= MAX_END_GAP,
    docCoverage,
  };
}

/**
 * Which bar a narration missed, in a sentence a caller can act on. Asked in
 * the order `judge` asks, so the reason given is the first gate that actually
 * refused. Lives beside the gate itself because the sentence and the verdict
 * must quote the same numbers — every caller that reports a failure sends it
 * verbatim.
 */
export function gateRefusal(
  meta: WorkerOut["meta"],
  docCoverage: number,
): string {
  const pct = (fraction: number) => `${Math.round(100 * fraction)}%`;
  if (meta.median_conf < MIN_MEDIAN_CONF) {
    return (
      `it aligned at median confidence ${meta.median_conf.toFixed(2)}; the bar is ` +
      `${MIN_MEDIAN_CONF} — the recording and the text may have drifted apart.`
    );
  }
  if (meta.span_coverage < MIN_COVERAGE) {
    return (
      `only ${pct(meta.span_coverage)} of the text between the first and last matched ` +
      `paragraph lined up; the bar is ${pct(MIN_COVERAGE)} — somewhere in the middle the ` +
      `reading and the words part ways.`
    );
  }
  if (docCoverage < MIN_DOC_COVERAGE) {
    return (
      `only ${pct(docCoverage)} of the tale's paragraphs matched the recording; the bar ` +
      `is ${pct(MIN_DOC_COVERAGE)} — it may cover just part of the tale.`
    );
  }
  if (meta.lead_s > MAX_LEAD_S) {
    return (
      `the recording plays for ${Math.round(meta.lead_s)} seconds before the first ` +
      `paragraph it matched; the bar is ${MAX_LEAD_S} — its opening didn't line up.`
    );
  }
  const gaps = endGaps(meta);
  if (gaps.start > MAX_END_GAP) {
    return (
      `the narration starts ${pct(gaps.start)} of the way into the text; the bar is ` +
      `${pct(MAX_END_GAP)} — it may skip the tale's opening.`
    );
  }
  return (
    `the narration stops ${pct(gaps.end)} short of the text's end; the bar is ` +
    `${pct(MAX_END_GAP)} — it may cover just part of the tale.`
  );
}
