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
    phrases: number;
    median_conf: number;
    device: string;
    /** Which acoustic backend produced this ("wav2vec2" | "mms_fa");
     *  absent from older workers' output. */
    model?: string;
  };
};
