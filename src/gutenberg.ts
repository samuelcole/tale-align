/**
 * Project Gutenberg epub → an anchored book body: `<section id>` blocks with
 * every `<p>` carrying an explicit `id`, byte-stable across re-runs — this is
 * the anchor scheme the rest of the pipeline (and any reader built on top of
 * it) keys every paragraph timing and deep link on.
 *
 * Gutenberg's text is public domain; its own license only governs the
 * "Project Gutenberg" trademark and the boilerplate wrapped around the text,
 * so this strips every such reference (the `pg-header`/`pg-footer` spine
 * items and the license notice) and keeps only the unrestricted prose.
 *
 * Gutenberg's epubs give chapters as `<h2>` + `<p>` inside `<div
 * class="chapter">`, not clean semantic sections, so file boundaries aren't
 * trusted: the content spine is flattened into a stream of blocks and a new
 * section is cut at every heading, minting a stable id from the heading text
 * and baking every paragraph id in.
 *
 * Identity (title, author, language) is read from the epub's own OPF
 * metadata rather than supplied by a caller — this module only needs the
 * file itself.
 *
 * The conversion is written as expressions over immutable values, and what it
 * returns is frozen. The one exemption is cheerio: its DOM API *is* mutation
 * (`.remove()`, `.attr()`, `.replaceWith()`, and the attribute strip in
 * `spineBlocks`), and every such call lands on a tree this module just parsed
 * and reads back out as a string — never on anything a caller owns.
 */

import AdmZip from "adm-zip";
import * as cheerio from "cheerio";
import { deepFreeze } from "./core.ts";

const UA = "tale-align/0.1 (+https://github.com/samuelcole/tale-align)";

// Ported verbatim from tale.fyi's body slugifier so section ids stay
// byte-identical to the scheme this package's anchor contract depends on.
export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Rewrite an internal epub cross-reference to a same-page hash: the whole
 * book renders as one page, so a link into another spine file has to point
 * at an anchor *here*, not at a file that never ships. A fragment keeps its
 * target (`chapter5.xhtml#note3` → `#note3`); a bare file link falls back to
 * the file's basename (`notes.xhtml` → `#notes`); absolute `http(s):`/
 * `mailto:` links and links already written as `#hashes` are returned
 * untouched. Gutenberg's content docs are usually `.xhtml` but sometimes
 * `.html`/`.htm`, so all three are stripped. This is href-side only: the
 * section/paragraph ids are minted elsewhere.
 */
export function samePageHref(href: string): string {
  if (/^[a-z]+:/i.test(href) || href.startsWith("#")) {
    return href;
  }
  const [file, anchor] = href.split("#");
  const target = file
    .split("/")
    .pop()
    ?.replace(/\.(?:xhtml|html|htm)$/i, "");
  return `#${anchor ?? target}`;
}

/**
 * Fetch a book's epub from Gutenberg's own cache mirror. Most books ship an
 * "-images" edition; a handful (mostly very old ids) only have the plain
 * one, so that's tried second. Throws if neither exists.
 */
export async function fetchGutenbergEpub(id: string): Promise<Buffer> {
  for (const name of [`pg${id}-images.epub`, `pg${id}.epub`]) {
    const res = await fetch(
      `https://www.gutenberg.org/cache/epub/${id}/${name}`,
      { headers: { "user-agent": UA } },
    );
    if (res.ok) {
      return Buffer.from(await res.arrayBuffer());
    }
  }
  throw new Error(`no epub found for Gutenberg id ${id}`);
}

export type GutenbergBook = {
  title: string;
  author: string | null;
  language: string;
  body: string;
};

/** Spine items that are never book text — cover and nav. Deliberately NOT
 *  `pg-header`/`pg-footer`: Gutenberg's generator assigns the id `pg-header`
 *  to the whole first *content* file when it splits a large book, so an
 *  idref-level skip throws away the title page, preface, and opening chapter
 *  along with the boilerplate (PG 46 loses all of Stave One). Boilerplate is
 *  removed at the DOM level instead, where the cut is exact. */
const SKIP_IDREF = /^(cover|coverpage|toc|nav)/i;
/** A block whose text is PG plumbing rather than the book. */
const PG_MARKER =
  /project gutenberg|start of (the|this) project|end of (the|this) project/i;

/** A section that's front/back matter, not the book itself. */
const SKIP_TITLE = /^(contents|table of contents|transcriber|illustrations)/i;

/**
 * Gutenberg's `dc:creator` is usually "Last, First"; flip it to reading
 * order when that's unambiguous — exactly one comma — and leave anything
 * else (multiple creators joined by commas, a "Jr." suffix, no comma at
 * all) exactly as the epub wrote it.
 */
function flipLastFirst(name: string): string {
  const parts = name.split(",");
  return parts.length === 2 ? `${parts[1].trim()} ${parts[0].trim()}` : name;
}

/** Open an epub's OPF the way the spec says to: container.xml names it. */
function openOpf(zip: AdmZip) {
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

/**
 * One spine document's body-level blocks, in reading order, tidied: PG's
 * boilerplate wrappers gone, bare anchors unwrapped, cross-file links pointed
 * back at this page, images and styling attributes dropped.
 *
 * This is where the cheerio exemption lives (see the module header): the
 * mutations below are all applied to the tree parsed on the first line and
 * returned as strings.
 */
function spineBlocks(html: string): string[] {
  const page = cheerio.load(html);
  // The PG license/machine-header boilerplate lives in these wrappers —
  // remove them by DOM id, not by spine idref (see SKIP_IDREF above). The
  // block-level PG_MARKER test below stays as the backstop for stray
  // "*** START/END ***" lines outside the wrappers.
  page("#pg-header, #pg-footer").remove();
  // Gutenberg scatters bare anchor targets (`<a id="chap24">`) for its own
  // TOC; unwrap every hrefless <a> so they don't become stray blocks that
  // confuse sectioning — keep any text, drop the anchor.
  page("a:not([href])").each((_i, a) => {
    page(a).replaceWith(page(a).contents());
  });
  // Cross-reference links ("chapter5.xhtml#note3") point at other spine
  // files, but the book renders as one page — rewrite them to same-page
  // hashes so they resolve here instead of pointing at a file that never
  // ships.
  page("a[href]").each((_i, a) => {
    const href = page(a).attr("href");
    if (href) {
      page(a).attr("href", samePageHref(href));
    }
  });
  // Drop images and, except id/href, every attribute — Gutenberg leans on
  // class-based styling this pipeline doesn't keep. This just tidies the
  // body; sanitizing untrusted HTML for render is the consumer's job.
  page("img, svg, figure, figcaption").remove();
  page("body *").each((_i, node) => {
    const attribs = (node as { attribs?: Record<string, string> }).attribs;
    if (attribs) {
      for (const attr of Object.keys(attribs)) {
        if (attr !== "id" && attr !== "href") {
          delete attribs[attr];
        }
      }
    }
  });
  return page("body")
    .children()
    .toArray()
    .flatMap((node) => {
      // Unwrap Gutenberg's <div class="chapter"> wrappers to reach the blocks.
      const children =
        node.tagName === "div" ? page(node).children() : page(node);
      return children
        .toArray()
        .filter((child) => !PG_MARKER.test(page(child).text()))
        .map((child) => (page.html(child) ?? "").trim())
        .filter(Boolean);
    });
}

/**
 * Section ids in document order: the slug itself the first time it appears,
 * then `-2`, `-3`, … for a repeat (a book with two chapters both titled
 * "Chapter I"). A fold over the ids minted so far — the candidates are
 * generated and the first free one wins, so there's no counter to carry.
 */
function mintIds(bases: readonly string[]): string[] {
  return bases.reduce<string[]>((ids, base) => {
    const taken = new Set(ids);
    const candidates = Array.from({ length: ids.length + 1 }, (_, n) =>
      n === 0 ? base : `${base}-${n + 1}`,
    );
    // The accumulator here is one book's sections — tens, occasionally
    // hundreds — so a copy per section costs far less than the epub parse that
    // produced them, and it buys the thing this module is trying to be.
    // biome-ignore lint/performance/noAccumulatingSpread: a section list is small, and not editing a built value is the point
    return [...ids, candidates.find((c) => !taken.has(c)) ?? base];
  }, []);
}

/** A block's heading text, or null when it isn't a heading. Entities decode to
 *  spaces so a heading like "STAVE&nbsp;TWO" slugs to "stave-two", not
 *  "stave-nbsp-two". */
function headingText(html: string): string | null {
  const m = html.match(/^<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
  return m
    ? m[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
        .replace(/&[a-z]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
    : null;
}

export function epubToAnchored(data: Buffer): GutenbergBook {
  const zip = new AdmZip(data);
  const { opf, opfDir, readEntry } = openOpf(zip);
  const { title, author, language } = epubIdentity(data);

  const hrefById = new Map<string, string>(
    opf("manifest > item")
      .toArray()
      .flatMap((el) => {
        const id = opf(el).attr("id");
        const href = opf(el).attr("href");
        return id && href ? [[id, href] as [string, string]] : [];
      }),
  );

  // Walk the spine, skipping cover/header/footer, and collect body-level blocks
  // as HTML strings in reading order.
  const blocks = opf("spine > itemref")
    .toArray()
    .flatMap((el) => {
      const idref = opf(el).attr("idref") ?? "";
      const href = hrefById.get(idref);
      if (SKIP_IDREF.test(idref) || !href) {
        return [];
      }
      return spineBlocks(readEntry(opfDir ? `${opfDir}/${href}` : href));
    });

  // Cut a new section at every heading; text before the first heading is the
  // "beginning" section. The cuts are the heading positions (plus 0, when the
  // book opens with something else), and each section is the slice up to the
  // next cut.
  const headings = blocks.flatMap((html, i) =>
    headingText(html) === null ? [] : [i],
  );
  const cuts = headings[0] === 0 ? headings : [0, ...headings];
  const sections =
    blocks.length === 0
      ? []
      : cuts.map((start, i) => ({
          title: headingText(blocks[start]),
          html: blocks.slice(start, cuts[i + 1] ?? blocks.length),
        }));

  // Bake ids: section id from heading (deduped), paragraph ids counting
  // every <p> in document order — the anchor scheme this pipeline keys on.
  const kept = sections.filter((s) => !(s.title && SKIP_TITLE.test(s.title)));
  const ids = mintIds(
    kept.map(
      (s, i) =>
        (s.title && slugify(s.title)) ||
        (i === 0 ? "beginning" : `section-${i + 1}`),
    ),
  );
  const body = kept
    .map((s, i) => {
      const id = ids[i];
      const section = cheerio.load(
        `<section id="${id}">${s.html.join("\n")}</section>`,
      );
      section("p").each((n, p) => {
        if (!section(p).attr("id")) {
          section(p).attr("id", `${id}-p${n + 1}`);
        }
      });
      return section("section").prop("outerHTML") ?? "";
    })
    .join("\n")
    .trim();
  if (!body) {
    throw new Error(`${title}: no readable body after conversion`);
  }
  return deepFreeze({ title, author, language, body });
}
