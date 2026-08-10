import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DOC_FILE, type Doc } from "./types/Doc.ts";

// Keep in step with package.json's version — bumped as part of each release.
export const VERSION = "0.2.0";
/** Runtime provenance: which build wrote this document. It lives with the
 *  writer that stamps it, not with the type — the shape a consumer reads is
 *  `FORMAT`, and that is the thing versioned in ./types/Doc.ts. */
export const GENERATOR = `tale-align/${VERSION}`;

/** Compact on purpose: the words map for a novel runs to megabytes, and this
 *  file is a machine transport — FORMAT.md is the human-readable half. The
 *  generator stamp goes on the written document, not the caller's object. */
export async function saveDoc(dir: string, doc: Doc): Promise<void> {
  const stamped = { ...doc, generator: GENERATOR };
  await writeFile(path.join(dir, DOC_FILE), `${JSON.stringify(stamped)}\n`);
}
