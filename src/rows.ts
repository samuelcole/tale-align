import type { PhraseRow } from "./types/WorkerOut.ts";

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
