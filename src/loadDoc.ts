import { readFile } from "node:fs/promises";
import path from "node:path";
import { deepFreeze } from "./deepFreeze.ts";
import { GENERATOR } from "./saveDoc.ts";
import { DOC_FILE, type Doc, FORMAT } from "./types/Doc.ts";

/** Read a work directory's document, or start a fresh one if none exists yet.
 *  A file that exists but declares another format is an error, not a restart —
 *  silently clobbering someone's data is worse than asking them to look. The
 *  document comes back frozen: a stage that wants to add its half builds the
 *  next document from this one (`{ ...doc, audio }`) rather than editing it. */
export async function loadDoc(dir: string): Promise<Doc> {
  const file = path.join(dir, DOC_FILE);
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) {
    return deepFreeze({ format: FORMAT, generator: GENERATOR });
  }
  const doc = JSON.parse(raw) as Doc;
  if (doc.format !== FORMAT) {
    throw new Error(
      `${file}: unknown format "${doc.format}" (expected ${FORMAT})`,
    );
  }
  return deepFreeze(doc);
}
