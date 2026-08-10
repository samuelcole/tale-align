import type { Fragment } from "./types/Fragment.ts";

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
