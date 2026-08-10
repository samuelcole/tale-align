/**
 * LibriVox → one recording's identity and its ordered sections. LibriVox
 * volunteers read public-domain books chapter by chapter and host the results
 * on archive.org; this resolves a recording id to what the feed knows, and
 * ./downloadSections.ts is what puts those sections on disk.
 */

import { deepFreeze } from "./deepFreeze.ts";
import type {
  LibriVoxRecording,
  LibriVoxSection,
} from "./types/LibriVoxRecording.ts";

const UA = "tale-align/0.1 (+https://github.com/samuelcole/tale-align)";

/** The slice of LibriVox's extended feed shape this module actually reads. */
type LvFeed = {
  books?: {
    title?: string;
    url_librivox?: string;
    sections?: {
      section_number?: string;
      title?: string;
      listen_url?: string;
      readers?: { display_name?: string }[];
    }[];
  }[];
};

/** `http://` → `https://`, and `www.archive.org` → the canonical bare host —
 *  the feed and archive.org itself serve the same file under both forms. */
function normalizeListenUrl(url: string): string {
  return url
    .replace(/^http:/, "https:")
    .replace("://www.archive.org", "://archive.org");
}

/** Fetch one LibriVox recording's identity and ordered sections. */
export async function fetchRecording(id: string): Promise<LibriVoxRecording> {
  const feedUrl = `https://librivox.org/api/feed/audiobooks/?format=json&extended=1&id=${id}`;
  const res = await fetch(feedUrl, { headers: { "user-agent": UA } });
  if (!res.ok) {
    throw new Error(`librivox HTTP ${res.status}`);
  }
  const json = (await res.json()) as LvFeed;
  const book = json.books?.[0];
  if (!book) {
    throw new Error(`librivox: no recording found for id ${id}`);
  }

  // LibriVox's own section_number is the ordering key; positions are then
  // renumbered 1..n in that order rather than trusted as-is (feeds are
  // occasionally 0-based, gappy, or out of order).
  const ordered = (book.sections ?? []).toSorted(
    (a, b) => Number(a.section_number) - Number(b.section_number),
  );
  const sections: LibriVoxSection[] = ordered.map((s, i) => ({
    position: i + 1,
    title: s.title?.trim() || null,
    reader: s.readers?.[0]?.display_name?.trim() || null,
    listenUrl: normalizeListenUrl(s.listen_url ?? ""),
  }));

  return deepFreeze({
    id,
    url: book.url_librivox || feedUrl,
    title: book.title ?? "",
    sections,
  });
}
