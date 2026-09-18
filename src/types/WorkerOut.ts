/** One phrase of a paragraph: [phraseIndex, beginSecs, confidence, section]. */
export type PhraseRow = [number, number, number, number];

/** One aligned word for the archive: [beginSecs, normalizedWord, confidence]. */
export type WordRow = [number, string, number];

/** Everything the Python aligner emits for one book: the phrase-level sync map
 *  a reader renders, the word-level archive a finer cut re-derives from, and
 *  the metrics the gate judges. */
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
    /** How far into the narrative the narration starts, and how far short of
     *  its end it stops — fractions of the narrative's paragraphs, apparatus
     *  (endnotes, appendices, prefaces, cast lists) left out of the measure.
     *  Null when nothing placed. Absent only from workers before 0.6.0, whose
     *  output the gate refuses to judge. */
    start_gap?: number | null;
    end_gap?: number | null;
    phrases: number;
    median_conf: number;
    device: string;
    /** Which acoustic backend produced this ("wav2vec2" | "mms_fa");
     *  absent from older workers' output. */
    model?: string;
    /** The language rule the words were normalized under (a BCP-47 primary
     *  subtag); absent from older workers' output, which was always English. */
    language?: string;
    /**
     * What produced this verdict. All four are absent from older workers'
     * output, so a consumer records "unknown" rather than assuming today's.
     *
     * A refusal is only interpretable against the thing that refused: the same
     * book and the same recording can pass one build and fail the next. These
     * are reported by the worker rather than by its caller because the caller
     * can only describe a sibling — it knows which package it resolved, not
     * which code ran.
     */
    /** The tale-align release this worker is installed inside. */
    tale_align?: string;
    /** First 12 hex of sha256 over the worker's own source. Moves when the
     *  code does, including for a hand-copied or locally patched install that
     *  leaves the version untouched. */
    worker_sha?: string;
    /** Floor-pinned in requirements.txt, so these drift with no release:
     *  they select the model bundle and the CTC kernels. */
    torch?: string;
    torchaudio?: string;
  };
};
