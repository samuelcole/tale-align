import AdmZip from "adm-zip";
import { deepFreeze } from "./deepFreeze.ts";
import { flipLastFirst, openOpf } from "./opf.ts";

/** A book's identity from its own OPF metadata — no catalog, no caller-
 *  supplied title/author. Cheap enough for a stage-1 fetch to stamp
 *  provenance without running the whole conversion. */
export function epubIdentity(data: Buffer): {
  title: string;
  author: string | null;
  language: string;
} {
  const { opf } = openOpf(new AdmZip(data));
  const title = opf("metadata > dc\\:title").first().text().trim();
  if (!title) {
    throw new Error("epub: missing dc:title");
  }
  const creator = opf("metadata > dc\\:creator").first().text().trim();
  return deepFreeze({
    title,
    author: creator ? flipLastFirst(creator) : null,
    language: opf("metadata > dc\\:language").first().text().trim() || "en",
  });
}
