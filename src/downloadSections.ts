/**
 * A LibriVox recording's audio, laid out on disk in playing order.
 *
 * Downloads are resumable — a file already on disk is kept as-is, just
 * re-probed for its real duration — and paced: archive.org is a shared
 * public resource, not a CDN, so this pauses between sections rather than
 * hammering it.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { deepFreeze } from "./deepFreeze.ts";
import { download } from "./download.ts";
import { probeSecs } from "./probeSecs.ts";
import type { SectionEntry } from "./types/Doc.ts";
import type { LibriVoxRecording } from "./types/LibriVoxRecording.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  // One section at a time, on purpose (see the pacing note above): the
  // generator yields an entry only once its file is on disk, and
  // `Array.fromAsync` drains it in order, so the sequence is the accumulator.
  async function* fetched(): AsyncGenerator<SectionEntry> {
    for (const section of rec.sections) {
      const filename = `${String(section.position).padStart(4, "0")}.mp3`;
      const file = path.join(audioDir, filename);
      const label = `${rec.title} #${section.position}`;

      if (!(await isNonEmptyFile(file))) {
        try {
          await download(section.listenUrl, file, label);
        } catch {
          // archive.org's per-item nodes are occasionally cold; one retry
          // covers a transient miss, a second failure is a real problem.
          await download(section.listenUrl, file, label);
        }
        // Gentle pacing between downloads — archive.org is a shared public
        // resource, not a CDN.
        await sleep(500);
      }

      yield {
        position: section.position,
        file: path.posix.join(audioDirName, filename),
        secs: await probeSecs(file),
        title: section.title,
        reader: section.reader,
      };
    }
  }
  return deepFreeze(await Array.fromAsync(fetched()));
}
