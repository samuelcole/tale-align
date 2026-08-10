/**
 * What a read-along IS: the paragraphs an alignment targets, the rows it turns
 * into, and the gate that decides whether any of it ships.
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
 * download, the ffprobe call — is ./worker.ts, and it lives apart precisely so
 * a caller can import the gate and the anchor extraction without dragging
 * `node:child_process` into its bundle. If something here ever needs an env
 * var or a driver, it belongs over there.
 *
 * Consumers pass anchored HTML — the `<p id="…">` markup a reader deep-links
 * into. Rendering markdown or any other source format down to that HTML is
 * the caller's business; this module only ever reads the anchors.
 */

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
 * `MAX_LEAD_S` / `MAX_TAIL_S`: but the narration's own ends must align — the
 * first placed paragraph near the audio's start, the last near its end. A big
 * lead means content that IS narrated didn't lock (read-along would start
 * minutes in, nothing lit before), which coverage-over-a-span can't see; this
 * is what actually keeps a genuinely broken opening out. ~2 min absorbs a
 * recording's own intro and a section title without letting a real gap through.
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
export const MAX_TAIL_S = 120;

/**
 * Above this length, the worker streams its emission to a disk memmap instead of
 * holding it in RAM — otherwise a 20h+ book's whole emission plus its phase-1
 * search exhausts memory and the OS kills it (An Autobiography, 21.8h, used to
 * climb for an hour then die). Streaming is somewhat slower per book (a memmap
 * read + cast per align vs a zero-copy slice), so only the giants pay it;
 * everything under 15h stays resident and fast. 15h is twice the longest book
 * that aligns comfortably in RAM.
 */
export const STREAM_SECS = 54_000;

/** Default UA for audio downloads — callers can override it. */
export const DEFAULT_UA =
  "tale-align/0.1 (+https://github.com/samuelcole/tale-align)";

export type Fragment = [id: string, text: string];
/** One phrase of a paragraph: [phraseIndex, beginSecs, confidence, section]. */
export type PhraseRow = [number, number, number, number];
/** One aligned word for the archive: [beginSecs, normalizedWord, confidence]. */
export type WordRow = [number, string, number];
export type WorkerOut = {
  phrases: Record<string, PhraseRow[]>;
  words: Record<string, WordRow[]>;
  meta: {
    paras: number;
    placed: number;
    /** Placed as a fraction of the paragraphs *between the first and last
     * placed* — so un-narrated front/back matter (prefaces, endnotes) doesn't
     * count against a book whose actual read text aligned. */
    span_coverage: number;
    /** Seconds of audio before the first placed paragraph, and after the last —
     * a big lead/tail means narrated content that failed to align at an end. */
    lead_s: number;
    tail_s: number;
    phrases: number;
    median_conf: number;
    device: string;
    /** Which acoustic backend produced this ("wav2vec2" | "mms_fa");
     *  absent from older workers' output. */
    model?: string;
  };
};

/**
 * A book's anchored paragraphs, in document order — the alignment targets. The
 * input is anchored HTML carrying `<p id="…">` (the anchor contract), so these
 * ids are exactly what a reader renders and deep links use. Rendering markdown
 * or any other source format to that anchored HTML is the caller's business —
 * this function only ever reads `<p id>` tags. One- and zero-word paragraphs
 * are dropped: the aligner needs words to lock onto, and they are not worth a
 * row.
 */
export function paragraphs(body: string): Fragment[] {
  return [...body.matchAll(/<p id="([^"]+)">([\s\S]*?)<\/p>/g)]
    .map(
      (m): Fragment => [
        m[1],
        m[2]
          .replace(/<[^>]+>/g, "")
          .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&[a-z]+;/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      ],
    )
    .filter(([, text]) => text.split(" ").length >= 2);
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
  return {
    pass:
      meta.median_conf >= MIN_MEDIAN_CONF &&
      meta.span_coverage >= MIN_COVERAGE &&
      docCoverage >= MIN_DOC_COVERAGE &&
      meta.lead_s <= MAX_LEAD_S &&
      meta.tail_s <= MAX_TAIL_S,
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
  return (
    `the recording keeps going for ${Math.round(meta.tail_s)} seconds after the last ` +
    `paragraph it matched; the bar is ${MAX_TAIL_S} — its ending didn't line up.`
  );
}

/** The phrase-level sync map a reader renders, flattened to rows. */
export function rows(phrases: Record<string, PhraseRow[]>) {
  return Object.entries(phrases).flatMap(([anchorId, list]) =>
    list.map(([phraseIndex, begin, conf, section]) => ({
      anchor_id: anchorId,
      phrase_index: phraseIndex,
      begin_secs: begin,
      confidence: conf,
      section,
    })),
  );
}

/**
 * Freeze a value and everything reachable through it, in place.
 *
 * Every value this library hands back is frozen on its way out the door, so a
 * caller who tries to edit a result *fails loudly* instead of quietly editing
 * a copy of the truth — the modules are all ESM, which is strict mode, so an
 * assignment to a frozen object throws a TypeError rather than being silently
 * dropped. It is the runtime half of the convention the source keeps: nothing
 * here reassigns a binding or mutates an object it did not just build.
 *
 * Only plain objects and arrays are walked. Buffers and other typed arrays are
 * returned untouched (freezing one throws — a view over a mutable buffer can't
 * honor it), and so is anything with a class prototype (a Map, a Date, a
 * cheerio node): freezing those breaks their own methods, which is a worse
 * bargain than the guarantee is worth. An already-frozen value is taken at its
 * word and not descended into.
 */
export function deepFreeze<T>(value: T): T {
  if (
    value === null ||
    typeof value !== "object" ||
    ArrayBuffer.isView(value) ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    return value;
  }
  // Freeze before descending: a structure that points back at itself then
  // stops on the second visit instead of recursing forever.
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
