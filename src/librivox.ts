/**
 * LibriVox → a book's spoken-word audio, laid out on disk in playing order.
 * LibriVox volunteers read public-domain books chapter by chapter and host
 * the results on archive.org; this resolves one LibriVox recording id to its
 * ordered sections (`fetchRecording`) and pulls each section's MP3 down into
 * a work directory (`downloadSections`).
 *
 * Downloads are resumable — a file already on disk is kept as-is, just
 * re-probed for its real duration — and paced: archive.org is a shared
 * public resource, not a CDN, so this pauses between sections rather than
 * hammering it.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import type { SectionEntry } from "./format.ts";
import { download, probeSecs } from "./worker.ts";

const UA = "tale-align/0.1 (+https://github.com/samuelcole/tale-align)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LibriVoxSection = {
  position: number;
  title: string | null;
  reader: string | null;
  listenUrl: string;
};

export type LibriVoxRecording = {
  id: string;
  url: string;
  title: string;
  sections: LibriVoxSection[];
};

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
  const ordered = [...(book.sections ?? [])].sort(
    (a, b) => Number(a.section_number) - Number(b.section_number),
  );
  const sections: LibriVoxSection[] = ordered.map((s, i) => ({
    position: i + 1,
    title: s.title?.trim() || null,
    reader: s.readers?.[0]?.display_name?.trim() || null,
    listenUrl: normalizeListenUrl(s.listen_url ?? ""),
  }));

  return {
    id,
    url: book.url_librivox || feedUrl,
    title: book.title ?? "",
    sections,
  };
}

async function isNonEmptyFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.size > 0;
  } catch {
    return false;
  }
}

/**
 * Download a recording's sections into `audioDir` (expected to be
 * `<workdir>/audio`) and return them as `SectionEntry[]`, ready to drop into
 * the interchange document. Resumable: a section whose file already exists
 * and is non-empty is kept rather than re-fetched, but still probed so its
 * duration is current. A download that fails is retried once; a second
 * failure throws and aborts the run rather than shipping a partial book.
 */
export async function downloadSections(
  rec: LibriVoxRecording,
  audioDir: string,
): Promise<SectionEntry[]> {
  // audioDir's own name (expected to be "audio") is what the stored path is
  // relative to — this doesn't need the work dir itself, just its basename.
  const audioDirName = path.basename(audioDir);
  const entries: SectionEntry[] = [];
  for (const section of rec.sections) {
    const filename = `${String(section.position).padStart(4, "0")}.mp3`;
    const file = path.join(audioDir, filename);
    const label = `${rec.title} #${section.position}`;

    if (!(await isNonEmptyFile(file))) {
      try {
        await download(section.listenUrl, file, label, UA);
      } catch {
        // archive.org's per-item nodes are occasionally cold; one retry
        // covers a transient miss, a second failure is a real problem.
        await download(section.listenUrl, file, label, UA);
      }
      // Gentle pacing between downloads — archive.org is a shared public
      // resource, not a CDN.
      await sleep(500);
    }

    entries.push({
      position: section.position,
      file: path.posix.join(audioDirName, filename),
      secs: await probeSecs(file),
      title: section.title,
      reader: section.reader,
    });
  }
  return entries;
}
