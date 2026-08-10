// Shared internals of the epub readers (./epubIdentity.ts, ./epubToAnchored.ts).
// Exported so those two can both use them, deliberately absent from the index
// barrel: internal by convention, not part of the package's API.

import type AdmZip from "adm-zip";
import * as cheerio from "cheerio";

/** Open an epub's OPF the way the spec says to: container.xml names it. */
export function openOpf(zip: AdmZip) {
  const readEntry = (p: string): string => {
    const entry = zip.getEntry(p);
    if (!entry) {
      throw new Error(`epub: missing ${p}`);
    }
    return entry.getData().toString("utf8");
  };
  const container = cheerio.load(readEntry("META-INF/container.xml"), {
    xml: true,
  });
  const opfPath = container("rootfile").attr("full-path");
  if (!opfPath) {
    throw new Error("epub: no OPF rootfile");
  }
  const opfDir = opfPath.includes("/")
    ? opfPath.slice(0, opfPath.lastIndexOf("/"))
    : "";
  return {
    opf: cheerio.load(readEntry(opfPath), { xml: true }),
    opfDir,
    readEntry,
  };
}

/**
 * Gutenberg's `dc:creator` is usually "Last, First"; flip it to reading
 * order when that's unambiguous — exactly one comma — and leave anything
 * else (multiple creators joined by commas, a "Jr." suffix, no comma at
 * all) exactly as the epub wrote it.
 */
export function flipLastFirst(name: string): string {
  const parts = name.split(",");
  return parts.length === 2 ? `${parts[1].trim()} ${parts[0].trim()}` : name;
}
