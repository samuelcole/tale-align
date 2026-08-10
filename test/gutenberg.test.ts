import { test } from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import {
  epubIdentity,
  epubToAnchored,
  samePageHref,
  slugify,
} from "../src/gutenberg.ts";

// ---------------------------------------------------------------------------
// Synthetic epub construction
// ---------------------------------------------------------------------------

/** Zips a path → content map into an epub Buffer. Callers supply every zip
 *  entry directly, including META-INF/container.xml and the OPF. */
function makeEpub(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) {
    zip.addFile(path, Buffer.from(content, "utf8"));
  }
  return zip.toBuffer();
}

const CONTAINER_XML = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

type SpineItem = {
  /** Used as both the manifest item id and the spine itemref idref. */
  idref: string;
  /** The content document's <body> innerHTML. */
  html: string;
};

/**
 * Assembles a full Gutenberg-shaped epub on top of `makeEpub`: a
 * container.xml pointing at an OPF under OEBPS/, one xhtml content document
 * per spine item (in order), and dc:title/dc:creator/dc:language metadata
 * that tests can override. Passing `null` for a metadata field omits that
 * tag entirely, rather than emitting it empty, so epubIdentity() sees it as
 * truly absent.
 */
function book(
  items: SpineItem[],
  metadata: {
    title?: string | null;
    creator?: string | null;
    language?: string | null;
  } = {},
): Buffer {
  const title = metadata.title === undefined ? "A Test Book" : metadata.title;
  const creator =
    metadata.creator === undefined ? "Doe, Jane" : metadata.creator;
  const language =
    metadata.language === undefined ? "en" : metadata.language;

  const manifest = items
    .map(
      (it) =>
        `<item id="${it.idref}" href="text/${it.idref}.xhtml" media-type="application/xhtml+xml"/>`,
    )
    .join("\n");
  const spine = items
    .map((it) => `<itemref idref="${it.idref}"/>`)
    .join("\n");
  const metaTags = [
    title !== null ? `<dc:title>${title}</dc:title>` : "",
    creator !== null ? `<dc:creator>${creator}</dc:creator>` : "",
    language !== null ? `<dc:language>${language}</dc:language>` : "",
  ].join("\n");

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    ${metaTags}
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`;

  const files: Record<string, string> = {
    "META-INF/container.xml": CONTAINER_XML,
    "OEBPS/content.opf": opf,
  };
  for (const it of items) {
    files[`OEBPS/text/${it.idref}.xhtml`] = `<html><body>${it.html}</body></html>`;
  }
  return makeEpub(files);
}

// ---------------------------------------------------------------------------
// slugify()
// ---------------------------------------------------------------------------

test("slugify() lowercases the input", () => {
  assert.equal(slugify("STAVE ONE"), "stave-one");
});

test("slugify() drops apostrophes without leaving a hyphen behind", () => {
  assert.equal(slugify("Marley's"), "marleys");
  assert.equal(slugify("Marley’s"), "marleys"); // curly apostrophe
});

test("slugify() collapses runs of non-alphanumeric characters to a single hyphen", () => {
  assert.equal(slugify("Stave One: A Ghost Story!!"), "stave-one-a-ghost-story");
});

test("slugify() trims leading and trailing hyphens", () => {
  assert.equal(slugify("  --Hello--  "), "hello");
});

// ---------------------------------------------------------------------------
// samePageHref()
// ---------------------------------------------------------------------------

test("samePageHref() keeps a fragment target on a cross-file link", () => {
  assert.equal(samePageHref("chapter5.xhtml#note3"), "#note3");
});

test("samePageHref() falls back to the file's basename when there is no fragment", () => {
  assert.equal(samePageHref("notes.xhtml"), "#notes");
});

test("samePageHref() strips .html and .htm the same as .xhtml", () => {
  assert.equal(samePageHref("notes.html"), "#notes");
  assert.equal(samePageHref("notes.htm"), "#notes");
});

test("samePageHref() strips a directory path down to the basename", () => {
  assert.equal(samePageHref("text/notes.xhtml"), "#notes");
});

test("samePageHref() leaves an already-same-page hash untouched", () => {
  assert.equal(samePageHref("#already"), "#already");
});

test("samePageHref() leaves absolute http(s) and mailto links untouched", () => {
  assert.equal(samePageHref("https://example.com/x"), "https://example.com/x");
  assert.equal(samePageHref("mailto:a@b.com"), "mailto:a@b.com");
});

// ---------------------------------------------------------------------------
// epubIdentity()
// ---------------------------------------------------------------------------

test("epubIdentity() throws when dc:title is missing", () => {
  const data = book([{ idref: "item1", html: "<p>hi there</p>" }], {
    title: null,
  });
  assert.throws(() => epubIdentity(data), /missing dc:title/);
});

test("epubIdentity() flips an exactly-one-comma creator from \"Last, First\" to \"First Last\"", () => {
  const data = book([{ idref: "item1", html: "<p>hi there</p>" }], {
    creator: "Dickens, Charles",
  });
  assert.equal(epubIdentity(data).author, "Charles Dickens");
});

test("epubIdentity() leaves a multi-comma creator untouched", () => {
  const data = book([{ idref: "item1", html: "<p>hi there</p>" }], {
    creator: "Smith, John, Jr.",
  });
  assert.equal(epubIdentity(data).author, "Smith, John, Jr.");
});

test("epubIdentity() leaves a comma-less creator untouched", () => {
  const data = book([{ idref: "item1", html: "<p>hi there</p>" }], {
    creator: "Charles Dickens",
  });
  assert.equal(epubIdentity(data).author, "Charles Dickens");
});

test("epubIdentity() returns author: null when dc:creator is missing", () => {
  const data = book([{ idref: "item1", html: "<p>hi there</p>" }], {
    creator: null,
  });
  assert.equal(epubIdentity(data).author, null);
});

test("epubIdentity() defaults language to \"en\" when dc:language is missing", () => {
  const data = book([{ idref: "item1", html: "<p>hi there</p>" }], {
    language: null,
  });
  assert.equal(epubIdentity(data).language, "en");
});

test("epubIdentity() reads an explicit dc:language", () => {
  const data = book([{ idref: "item1", html: "<p>hi there</p>" }], {
    language: "fr",
  });
  assert.equal(epubIdentity(data).language, "fr");
});

// ---------------------------------------------------------------------------
// epubToAnchored() — sectioning
// ---------------------------------------------------------------------------

test("epubToAnchored() cuts a new section at every heading, with paragraph ids counted per section", () => {
  const data = book([
    {
      idref: "item1",
      html:
        "<h2>Chapter One</h2><p>First.</p><p>Second.</p><h2>Chapter Two</h2><p>Third.</p>",
    },
  ]);
  const { body } = epubToAnchored(data);
  assert.match(body, /<section id="chapter-one">/);
  assert.match(body, /<section id="chapter-two">/);
  assert.match(body, /<p id="chapter-one-p1">First\.<\/p>/);
  assert.match(body, /<p id="chapter-one-p2">Second\.<\/p>/);
  assert.match(body, /<p id="chapter-two-p1">Third\.<\/p>/);
});

test("epubToAnchored() puts text before the first heading in a \"beginning\" section", () => {
  const data = book([
    {
      idref: "item1",
      html: "<p>Prologue text.</p><h2>Chapter One</h2><p>First.</p>",
    },
  ]);
  const { body } = epubToAnchored(data);
  assert.match(body, /<section id="beginning"><p id="beginning-p1">Prologue text\.<\/p><\/section>/);
  assert.match(body, /<section id="chapter-one">/);
});

test("epubToAnchored() dedupes identical headings by suffixing -2, -3, …", () => {
  const data = book([
    {
      idref: "item1",
      html: "<h2>Letter</h2><p>First.</p><h2>Letter</h2><p>Second.</p>",
    },
  ]);
  const { body } = epubToAnchored(data);
  assert.match(body, /<section id="letter">/);
  assert.match(body, /<section id="letter-2">/);
  assert.match(body, /<p id="letter-p1">First\.<\/p>/);
  assert.match(body, /<p id="letter-2-p1">Second\.<\/p>/);
});

// ---------------------------------------------------------------------------
// epubToAnchored() — Project Gutenberg boilerplate removal
// ---------------------------------------------------------------------------

test("epubToAnchored() keeps the real content of a split epub's pg-header-idref file (TAL-122)", () => {
  // Gutenberg's generator names the whole FIRST content file "pg-header"
  // (manifest id AND spine idref) when it splits a large book across
  // multiple xhtml files — this is a naming coincidence with the DOM id
  // `#pg-header` it also wraps its own boilerplate div in. If the pipeline
  // ever special-cased the idref (SKIP_IDREF matching "pg-header"), it would
  // throw away the title page, preface, AND opening chapter along with the
  // boilerplate — this is exactly what happened to PG 46 (A Christmas
  // Carol), which lost all of Stave One. The fix removes only the
  // `#pg-header` DOM node, so the real content sitting next to it survives.
  const data = book([
    {
      idref: "pg-header",
      html: `
<div id="pg-header">
<p>The Project Gutenberg eBook of A Christmas Carol, by Charles Dickens</p>
<p>*** START OF THE PROJECT GUTENBERG EBOOK A CHRISTMAS CAROL ***</p>
</div>
<h2>Stave One: Marley's Ghost</h2>
<p>Marley was dead, to begin with.</p>
<p>There is no doubt whatever about that.</p>`,
    },
    {
      idref: "item2",
      html: "<h2>Stave Two</h2><p>When Scrooge awoke, it was so dark.</p>",
    },
  ]);
  const { body } = epubToAnchored(data);

  // The real Stave One content survives...
  assert.match(body, /<section id="stave-one-marleys-ghost">/);
  assert.match(body, /Marley was dead, to begin with\./);
  assert.match(body, /There is no doubt whatever about that\./);
  // ...but the #pg-header boilerplate div's text does not appear anywhere.
  assert.ok(!body.includes("The Project Gutenberg eBook"));
  assert.ok(!body.includes("START OF THE PROJECT GUTENBERG EBOOK"));
  // The second spine file still comes through normally.
  assert.match(body, /<section id="stave-two">/);
});

test("epubToAnchored() removes a #pg-footer div while keeping its sibling content", () => {
  const data = book([
    {
      idref: "item1",
      html: `<h2>Chapter One</h2><p>Real content.</p><div id="pg-footer"><p>End of the Project Gutenberg EBook.</p></div>`,
    },
  ]);
  const { body } = epubToAnchored(data);
  assert.match(body, /Real content\./);
  assert.ok(!body.includes("End of the Project Gutenberg EBook"));
});

test("epubToAnchored() skips cover/toc/nav spine idrefs entirely", () => {
  const data = book([
    { idref: "cover", html: "<p>Cover page text.</p>" },
    {
      idref: "toc",
      html: `<h2>Contents</h2><p><a href="item1.xhtml">Chapter One</a></p>`,
    },
    { idref: "nav", html: "<p>Navigation text.</p>" },
    { idref: "item1", html: "<h2>Chapter One</h2><p>Real content.</p>" },
  ]);
  const { body } = epubToAnchored(data);
  assert.ok(!body.includes("Cover page text"));
  assert.ok(!body.includes("Navigation text"));
  assert.ok(!body.includes("Contents"));
  assert.match(body, /<section id="chapter-one">/);
  assert.match(body, /Real content\./);
});

test("epubToAnchored() drops a top-level PG start/end marker block while keeping its siblings", () => {
  const data = book([
    {
      idref: "item1",
      html: `<p>Before marker.</p><p>*** START OF THE PROJECT GUTENBERG EBOOK TEST ***</p><p>After marker.</p>`,
    },
  ]);
  const { body } = epubToAnchored(data);
  assert.match(body, /Before marker\./);
  assert.match(body, /After marker\./);
  assert.ok(!body.includes("START OF THE PROJECT GUTENBERG EBOOK TEST"));
});

test("epubToAnchored() drops a \"Contents\" section wholesale", () => {
  const data = book([
    {
      idref: "item1",
      html: `<h2>Contents</h2><p>Chapter One</p><p>Chapter Two</p><h2>Chapter One</h2><p>Real content.</p>`,
    },
  ]);
  const { body } = epubToAnchored(data);
  assert.ok(!body.includes("<section id=\"contents\">"));
  // "Chapter Two" only ever appears as one of the Contents section's entries
  // in this fixture, so its absence confirms the section was dropped
  // wholesale rather than just having its heading skipped.
  assert.ok(!body.includes("Chapter Two"));
  assert.match(body, /<section id="chapter-one">/);
  assert.match(body, /Real content\./);
});

test("epubToAnchored() drops an \"Illustrations\" section wholesale", () => {
  const data = book([
    {
      idref: "item1",
      html: `<h2>Illustrations</h2><p>Frontispiece</p><h2>Chapter One</h2><p>Real content.</p>`,
    },
  ]);
  const { body } = epubToAnchored(data);
  assert.ok(!body.includes("Frontispiece"));
  assert.match(body, /<section id="chapter-one">/);
  assert.match(body, /Real content\./);
});

// ---------------------------------------------------------------------------
// epubToAnchored() — heading text normalization
// ---------------------------------------------------------------------------

test("epubToAnchored() slugs a numeric-entity space in a heading to a single hyphen, not \"nbsp\"", () => {
  const data = book([
    { idref: "item1", html: "<h2>STAVE&#160;TWO</h2><p>Content.</p>" },
  ]);
  const { body } = epubToAnchored(data);
  assert.match(body, /<section id="stave-two">/);
  assert.ok(!body.includes("stave-nbsp-two"));
});

test("epubToAnchored() slugs a literal &nbsp; entity in a heading the same way", () => {
  // cheerio decodes &nbsp; while parsing and re-serializes it as the &nbsp;
  // entity again, so this ends up going through the exact same code path
  // (the named-entity branch) as the numeric-entity test above, regardless
  // of which form the source epub used.
  const data = book([
    { idref: "item1", html: "<h2>STAVE&nbsp;TWO</h2><p>Content.</p>" },
  ]);
  const { body } = epubToAnchored(data);
  assert.match(body, /<section id="stave-two">/);
  assert.ok(!body.includes("stave-nbsp-two"));
});

// ---------------------------------------------------------------------------
// epubToAnchored() — DOM cleanup
// ---------------------------------------------------------------------------

test("epubToAnchored() rewrites a cross-file href to a same-page hash", () => {
  const data = book([
    {
      idref: "item1",
      html: `<h2>Chapter One</h2><p>See <a href="notes.xhtml#n1">this note</a>.</p>`,
    },
  ]);
  const { body } = epubToAnchored(data);
  assert.match(body, /<a href="#n1">this note<\/a>/);
});

test("epubToAnchored() strips class/style attributes but keeps id and href", () => {
  const data = book([
    {
      idref: "item1",
      html: `<h2>Chapter One</h2><p class="fancy" style="color:red">Text with <a href="notes.xhtml#n1" class="xref">a link</a>.</p>`,
    },
  ]);
  const { body } = epubToAnchored(data);
  assert.ok(!body.includes("class="));
  assert.ok(!body.includes("style="));
  assert.match(body, /<p id="chapter-one-p1">/);
  assert.match(body, /<a href="#n1">a link<\/a>/);
});

test("epubToAnchored() removes images, figures, and figcaptions entirely", () => {
  const data = book([
    {
      idref: "item1",
      html: `<h2>Chapter One</h2><p>Real content.</p><figure><img src="pic.jpg"/><figcaption>A caption</figcaption></figure>`,
    },
  ]);
  const { body } = epubToAnchored(data);
  assert.ok(!body.includes("<img"));
  assert.ok(!body.includes("<figure"));
  assert.ok(!body.includes("<figcaption"));
  assert.ok(!body.includes("A caption"));
});

test("epubToAnchored() unwraps a hrefless anchor, keeping its text and dropping the tag", () => {
  const data = book([
    {
      idref: "item1",
      html: `<h2>Chapter One</h2><p><a id="chap1">bare anchor text</a> continues here.</p>`,
    },
  ]);
  const { body } = epubToAnchored(data);
  assert.ok(!body.includes("<a "));
  assert.ok(!body.includes('id="chap1"'));
  assert.match(body, /bare anchor text continues here\./);
});

// ---------------------------------------------------------------------------
// epubToAnchored() — failure mode
// ---------------------------------------------------------------------------

test("epubToAnchored() throws when every spine item is skipped or empty", () => {
  const data = book([
    { idref: "toc", html: "<h2>Contents</h2><p>Chapter One</p>" },
    { idref: "cover", html: "<p>Cover text.</p>" },
  ]);
  assert.throws(() => epubToAnchored(data), /no readable body/);
});
