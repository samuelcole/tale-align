import { test } from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import { epubIdentity } from "../src/epubIdentity.ts";

// ---------------------------------------------------------------------------
// Synthetic epub construction — the same builders epubToAnchored.test.ts uses,
// duplicated rather than shared: each suite reads on its own, and a fixture
// module for two callers is a dependency neither of them asked for.
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
  const language = metadata.language === undefined ? "en" : metadata.language;

  const manifest = items
    .map(
      (it) =>
        `<item id="${it.idref}" href="text/${it.idref}.xhtml" media-type="application/xhtml+xml"/>`,
    )
    .join("\n");
  const spine = items.map((it) => `<itemref idref="${it.idref}"/>`).join("\n");
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
    files[`OEBPS/text/${it.idref}.xhtml`] =
      `<html><body>${it.html}</body></html>`;
  }
  return makeEpub(files);
}

// ---------------------------------------------------------------------------
// epubIdentity()
// ---------------------------------------------------------------------------

test("epubIdentity() throws when dc:title is missing", () => {
  const data = book([{ idref: "item1", html: "<p>hi there</p>" }], {
    title: null,
  });
  assert.throws(() => epubIdentity(data), /missing dc:title/);
});

test('epubIdentity() flips an exactly-one-comma creator from "Last, First" to "First Last"', () => {
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

test('epubIdentity() defaults language to "en" when dc:language is missing', () => {
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
