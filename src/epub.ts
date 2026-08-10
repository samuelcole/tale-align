/**
 * Serialize a tale-align work directory into an EPUB 3 with Media Overlays.
 *
 * The alignment step already produced, per paragraph, the second in the
 * narration where it's first spoken — keyed to the same anchor id the
 * text's `<section id>`/`<p id>` markup carries. An EPUB 3 Media Overlay
 * wants exactly that, in a different envelope: a SMIL file whose `<par>`s
 * each tie a text fragment (`book.xhtml#<anchorId>`) to an audio clip
 * (`clipBegin`/`clipEnd` in one mp3). So this is serialization, not
 * alignment — a projection of what the pipeline already computed into the
 * open standard, which plays in Thorium, Calibre, Colibrio, and other
 * readers that honor overlays on reflowable books. (Apple Books limits
 * media overlays to fixed-layout epubs; this one opens there as plain text.)
 *
 * Paragraph-level for now (each anchored paragraph is one `<par>`); a finer,
 * word-level cut would re-derive from the same alignment data already on
 * disk.
 */

import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as cheerio from "cheerio";
import { DOC_FILE, type Doc, loadDoc, sha256 } from "./format.ts";

/** Escape a string for XML text/attribute content. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
/** A SMIL clock value in the seconds form EPUB accepts, e.g. "12.500s". */
const clock = (secs: number) => `${Math.max(0, secs).toFixed(3)}s`;

export async function exportEpub(
  dir: string,
  outPath: string,
  opts?: { force?: boolean },
): Promise<{
  synced: number;
  skipped: number;
  sections: number;
  totalSecs: number;
  readers: string[];
}> {
  const doc: Doc = await loadDoc(dir);
  const docFile = path.join(dir, DOC_FILE);
  if (!doc.book) {
    throw new Error(`${docFile}: no book — run \`import\` first`);
  }
  if (!doc.text) {
    throw new Error(`${docFile}: no text — run \`import\` first`);
  }
  if (!doc.audio) {
    throw new Error(`${docFile}: no audio — run \`fetch-audio\` first`);
  }
  if (!doc.alignment) {
    throw new Error(`${docFile}: no alignment — run \`align\` first`);
  }

  // Honor the verdict: the whole point of the gates is that a refused
  // alignment does not ship, unless the caller explicitly overrides it.
  if (!doc.alignment.verdict.pass && !opts?.force) {
    throw new Error(
      `alignment was refused: ${doc.alignment.verdict.refusal} (pass { force: true } to export anyway)`,
    );
  }

  // An edited text must never ship yesterday's timings.
  const bodyHtml = await readFile(path.join(dir, doc.text.file), "utf8");
  if (sha256(bodyHtml) !== doc.alignment.textSha256) {
    throw new Error("text changed since alignment; re-run align");
  }

  const book = doc.book;
  const audio = doc.audio;
  const alignment = doc.alignment;

  if (audio.sections.length === 0) {
    throw new Error(
      `${docFile}: no audio sections — run \`fetch-audio\` first`,
    );
  }

  // Whole-book time at the start of each section's file, and each file's
  // length. Sort defensively — the timeline math below is cumulative, so an
  // out-of-order array would skew every clip after the first mistake.
  const audioSections = [...audio.sections].sort(
    (a, b) => a.position - b.position,
  );
  const startAt = new Map<number, number>();
  let cum = 0;
  for (const a of audioSections) {
    startAt.set(a.position, cum);
    cum += a.secs;
  }
  // Which file a whole-book second falls in — walked from the timeline
  // rather than trusting a stored section column, which can disagree with
  // the position order and point a clip at the wrong file.
  const sectionAt = (b: number) => {
    let pos = audioSections[0].position;
    for (const a of audioSections) {
      if ((startAt.get(a.position) ?? 0) <= b) {
        pos = a.position;
      } else {
        break;
      }
    }
    return pos;
  };

  // The book as one XHTML content document — the text file already carries
  // the anchor ids the aligner keyed against, so the fragments resolve.
  const $ = cheerio.load(`<div id="tale-root">${bodyHtml}</div>`);
  // Two things XHTML needs that cheerio's XML output doesn't guarantee: &nbsp;
  // is an HTML entity XHTML doesn't predefine (numeric is legal), and void
  // elements must self-close (<br> → <br/>) or the parse is fatal.
  const VOID =
    "br|hr|img|col|wbr|area|base|embed|input|link|meta|param|source|track";
  const bodyXml = $.xml("#tale-root")
    .replace(/&nbsp;/g, "&#160;")
    .replace(new RegExp(`<(${VOID})\\b([^>]*?)\\/?>`, "gi"), "<$1$2/>");
  const presentIds = new Set(
    [...bodyXml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]),
  );
  const lang = esc(book.language);
  const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head><meta charset="utf-8"/><title>${esc(book.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>${bodyXml}</body>
</html>`;

  // The EPUB 3 navigation document (required — Apple Books won't open a book
  // without it): a table of contents built from the top-level sections, each
  // linking its anchor in the single content doc.
  const tocEntries = $("#tale-root > section[id]")
    .toArray()
    .map((el) => {
      const $el = $(el);
      return {
        id: $el.attr("id") ?? "",
        title: $el.find("h1, h2, h3, h4, h5, h6").first().text().trim(),
      };
    })
    .filter((s) => s.title && presentIds.has(s.id))
    .map(
      (s) =>
        `      <li><a href="book.xhtml#${esc(s.id)}">${esc(s.title)}</a></li>`,
    )
    .join("\n");
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head><meta charset="utf-8"/><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
${tocEntries || `      <li><a href="book.xhtml">${esc(book.title)}</a></li>`}
    </ol>
  </nav>
</body>
</html>`;

  // An EPUB reading app paints this class on the paragraph being spoken.
  // Because the OPF names it (media:active-class), a stylesheet must define
  // it in the content.
  const css = ".mo-active { background: #ffe9a8; color: #1a1a1a; }\n";

  // Paragraph begins, in whole-book seconds. Phrase 0 is the paragraph's
  // start when it placed — but a paragraph whose opening phrase never locked
  // can still carry later phrases, and requiring phrase 0 would drop it from
  // the overlay entirely (play-from-the-top would skip its narration). The
  // earliest placed phrase is the honest begin either way.
  const rows: { anchor_id: string; begin_secs: number }[] = [];
  for (const [anchorId, hits] of Object.entries(alignment.phrases)) {
    if (hits.length > 0) {
      rows.push({
        anchor_id: anchorId,
        begin_secs: Math.min(...hits.map((h) => h[1])),
      });
    }
  }
  rows.sort((a, b) => a.begin_secs - b.begin_secs);

  // One SMIL: a par per paragraph, its clip bounded by the next paragraph in
  // the same file (or the file's end). Whole-book begin → within-file clip.
  const within = rows
    .map((r) => {
      const section = sectionAt(r.begin_secs);
      return {
        anchor: r.anchor_id,
        section,
        begin: r.begin_secs - (startAt.get(section) ?? 0),
      };
    })
    .filter((r) => presentIds.has(r.anchor)); // skip anchors not in the render
  const skipped = rows.length - within.length;
  const usedSections = new Set(within.map((r) => r.section));
  let pars = "";
  within.forEach((r, i) => {
    const nextSame = within.slice(i + 1).find((x) => x.section === r.section);
    // Bound the clip by the next paragraph in the same file. The last
    // paragraph of a file gets no clipEnd, so it plays to the file's real
    // end — the stored `secs` is a rounded float that can drift below a
    // late paragraph's start.
    const clip = nextSame
      ? `clipBegin="${clock(r.begin)}" clipEnd="${clock(nextSame.begin)}"`
      : `clipBegin="${clock(r.begin)}"`;
    pars += `      <par id="p${i + 1}">
        <text src="book.xhtml#${esc(r.anchor)}"/>
        <audio src="audio/s${r.section}.mp3" ${clip}/>
      </par>\n`;
  });
  const smil = `<?xml version="1.0" encoding="utf-8"?>
<smil xmlns="http://www.w3.org/ns/SMIL" xmlns:epub="http://www.idpf.org/2007/ops" version="3.0">
  <body>
    <seq id="seq1" epub:textref="book.xhtml" epub:type="chapter">
${pars}    </seq>
  </body>
</smil>`;

  // OPF. Credit the source text and its narrator(s) as Dublin Core metadata,
  // the narrator marked "nrt". Only the files a paragraph actually points
  // into — a section that aligned nothing (a title page, a divider) ships no
  // orphaned audio.
  const usedAudio = audioSections.filter((a) => usedSections.has(a.position));
  const totalSecs = usedAudio.reduce((s, a) => s + a.secs, 0);
  const author = book.author ?? "Unknown";
  const readers = [
    ...new Set(usedAudio.map((a) => a.reader).filter((r): r is string => !!r)),
  ];
  const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const audioItems = usedAudio
    .map(
      (a) =>
        `    <item id="aud${a.position}" href="audio/s${a.position}.mp3" media-type="audio/mpeg"/>`,
    )
    .join("\n");
  const contributorMeta = readers
    .map(
      (r, i) =>
        `    <dc:contributor id="nrt${i}">${esc(r)}</dc:contributor>\n    <meta refines="#nrt${i}" property="role" scheme="marc:relators">nrt</meta>`,
    )
    .join("\n");
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" prefix="media: http://www.idpf.org/epub/vocab/overlays/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:tale-align:${esc(book.source.kind)}:${esc(book.source.id)}</dc:identifier>
    <dc:title>${esc(book.title)}</dc:title>
    <dc:language>${lang}</dc:language>
    <dc:creator>${esc(author)}</dc:creator>
${contributorMeta}
${[book.source.url, audio.source.url]
  .filter(Boolean)
  .map((u) => `    <dc:source>${esc(u)}</dc:source>`)
  .join("\n")}
    <meta property="dcterms:modified">${modified}</meta>
    <meta property="media:duration">${clock(totalSecs)}</meta>
    <meta property="media:duration" refines="#smil">${clock(totalSecs)}</meta>
    <meta property="media:active-class">mo-active</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="content" href="book.xhtml" media-type="application/xhtml+xml" media-overlay="smil"/>
    <item id="smil" href="book.smil" media-type="application/smil+xml"/>
${audioItems}
  </manifest>
  <spine>
    <itemref idref="content"/>
  </spine>
</package>`;

  // Lay out the EPUB in a temp dir, copy the audio files in from the work
  // directory, then zip with the mimetype first and stored (uncompressed) —
  // the one ordering EPUB requires.
  const resolvedOut = path.resolve(outPath);
  const tmp = await mkdtemp(path.join(tmpdir(), "epub-"));
  await writeFile(path.join(tmp, "mimetype"), "application/epub+zip");
  await mkdir(path.join(tmp, "META-INF"));
  await writeFile(
    path.join(tmp, "META-INF", "container.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );
  const oebps = path.join(tmp, "OEBPS");
  await mkdir(path.join(oebps, "audio"), { recursive: true });
  await writeFile(path.join(oebps, "content.opf"), opf);
  await writeFile(path.join(oebps, "book.xhtml"), xhtml);
  await writeFile(path.join(oebps, "book.smil"), smil);
  await writeFile(path.join(oebps, "nav.xhtml"), nav);
  await writeFile(path.join(oebps, "style.css"), css);

  for (const a of usedAudio) {
    await copyFile(
      path.join(dir, a.file),
      path.join(oebps, "audio", `s${a.position}.mp3`),
    );
  }

  await rm(resolvedOut, { force: true });
  const z1 = spawnSync("zip", ["-X", "-0", resolvedOut, "mimetype"], {
    cwd: tmp,
  });
  const z2 = spawnSync(
    "zip",
    ["-X", "-9", "-r", resolvedOut, "META-INF", "OEBPS"],
    { cwd: tmp },
  );
  if (z1.status !== 0 || z2.status !== 0) {
    throw new Error(`zip failed: ${z1.stderr || z2.stderr}`);
  }
  await rm(tmp, { recursive: true, force: true });

  return {
    synced: within.length,
    skipped,
    sections: usedAudio.length,
    totalSecs,
    readers,
  };
}
