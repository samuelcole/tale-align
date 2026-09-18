import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import * as cheerio from "cheerio";
import { exportEpub } from "../src/exportEpub.ts";
import { probeSecs } from "../src/probeSecs.ts";
import { saveDoc } from "../src/saveDoc.ts";
import type { Doc } from "../src/types/Doc.ts";

const execFileAsync = promisify(execFile);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// The book: three sections, two paragraphs each, all anchored the way the
// aligner's output is keyed.
const BOOK_HTML = `<section id="ch1">
  <h2>Chapter One</h2>
  <p id="ch1-p1">It was a dark and stormy night in the first chapter.</p>
  <p id="ch1-p2">The wind howled through the old house in the first chapter.</p>
</section>
<section id="ch2">
  <h2>Chapter Two</h2>
  <p id="ch2-p1">Morning came quietly over the second chapter.</p>
  <p id="ch2-p2">Nobody had slept a wink in the second chapter.</p>
</section>
<section id="ch3">
  <h2>Chapter Three</h2>
  <p id="ch3-p1">At last the truth came out in the third chapter.</p>
  <p id="ch3-p2">And so the story ends in the third chapter.</p>
</section>`;

let root: string;
let baseDir: string;
let secs1: number;
let secs2: number;
let secs3: number;
let baseDoc: Doc;

async function makeMp3(file: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-y",
    file,
  ]);
}

/** Copy the base fixture (html + audio) into a fresh dir, so a test that
 *  needs its own tale-align.json (or its own mutated book.html) can't
 *  disturb any other test's dir. */
async function forkFixtureDir(): Promise<string> {
  const dir = await mkdtemp(path.join(root, "fork-"));
  await writeFile(path.join(dir, "book.html"), BOOK_HTML);
  await mkdir(path.join(dir, "audio"));
  for (const n of [1, 2, 3]) {
    await copyFile(
      path.join(baseDir, "audio", `s${n}.mp3`),
      path.join(dir, "audio", `s${n}.mp3`),
    );
  }
  return dir;
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "epub-test-"));
  baseDir = path.join(root, "base");
  await mkdir(path.join(baseDir, "audio"), { recursive: true });
  await writeFile(path.join(baseDir, "book.html"), BOOK_HTML);

  await Promise.all(
    [1, 2, 3].map((n) => makeMp3(path.join(baseDir, "audio", `s${n}.mp3`))),
  );
  secs1 = await probeSecs(path.join(baseDir, "audio", "s1.mp3"));
  secs2 = await probeSecs(path.join(baseDir, "audio", "s2.mp3"));
  secs3 = await probeSecs(path.join(baseDir, "audio", "s3.mp3"));

  const textSha256 = sha256(BOOK_HTML);
  baseDoc = {
    format: "tale-align/v1",
    generator: "test",
    book: {
      title: "Test Book",
      author: "A. Uthor",
      language: "en",
      source: { kind: "test", id: "book1", url: "https://example.com/book1" },
    },
    text: { file: "book.html", sha256: textSha256, paragraphs: 6 },
    audio: {
      source: { kind: "test", id: "rec1", url: "https://example.com/rec1" },
      sections: [
        {
          position: 1,
          file: "audio/s1.mp3",
          secs: secs1,
          title: "Chapter One",
          reader: "Jane Reader",
        },
        {
          position: 2,
          file: "audio/s2.mp3",
          secs: secs2,
          title: "Chapter Two",
          reader: "Jane Reader",
        },
        {
          position: 3,
          file: "audio/s3.mp3",
          secs: secs3,
          title: "Chapter Three",
          reader: "John Other",
        },
      ],
    },
    alignment: {
      model: "wav2vec2",
      alignedAt: new Date().toISOString(),
      textSha256,
      phrases: {
        "ch1-p1": [[0, 0.1, 0.95, 1]],
        // No phrase-index-0 row at all — the paragraph should still surface,
        // at the earliest begin among the rows it does have (min, not the
        // index-0 row specifically).
        "ch1-p2": [
          [2, 1.6, 0.9, 1],
          [1, 1.2, 0.85, 1],
        ],
        "ch2-p1": [[0, secs1 + 0.3, 0.93, 2]],
        "ch2-p2": [[0, secs1 + 0.7, 0.91, 2]],
        "ch3-p1": [[0, secs1 + secs2 + 0.2, 0.94, 3]],
        "ch3-p2": [[0, secs1 + secs2 + 0.6, 0.92, 3]],
        // Not a real anchor in book.html — should be skipped, not exported.
        "ghost-p1": [[0, secs1 + 0.5, 0.5, 2]],
      },
      words: {},
      meta: {
        paras: 6,
        placed: 6,
        span_coverage: 1.0,
        lead_s: 0.1,
        tail_s: 0.1,
        phrases: 7,
        median_conf: 0.9,
        device: "cpu",
        model: "wav2vec2",
      },
      verdict: {
        pass: true,
        docCoverage: 1.0,
        refusal: null,
        gates: {
          minMedianConf: 0.8,
          minCoverage: 0.9,
          minDocCoverage: 0.5,
          maxLeadS: 125,
          maxEndGap: 0.05,
        },
      },
    },
  };
  await saveDoc(baseDir, baseDoc);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Parse a book.smil buffer into its <par> rows, each with its text/audio
 *  anchor, section file, and clip bounds (undefined clipEnd means none). */
function parseSmilPars(smil: string) {
  const $ = cheerio.load(smil, { xmlMode: true });
  return $("par")
    .toArray()
    .map((el) => {
      const $el = $(el);
      const audio = $el.find("audio");
      const textSrc = $el.find("text").attr("src") ?? "";
      return {
        anchor: textSrc.split("#")[1] ?? "",
        audioSrc: audio.attr("src") ?? "",
        clipBegin: Number.parseFloat(audio.attr("clipBegin") ?? "NaN"),
        clipEnd: audio.attr("clipEnd")
          ? Number.parseFloat(audio.attr("clipEnd") ?? "NaN")
          : undefined,
      };
    });
}

test("exports an epub with mimetype first/stored and the standard OEBPS layout", async () => {
  const outPath = path.join(root, "structure.epub");
  await exportEpub(baseDir, outPath);

  const zip = new AdmZip(outPath);
  const entries = zip.getEntries();

  assert.equal(entries[0].entryName, "mimetype");
  assert.equal(
    entries[0].header.method,
    0,
    "mimetype must be stored, not deflated",
  );
  assert.equal(zip.readAsText("mimetype"), "application/epub+zip");

  const names = new Set(entries.map((e) => e.entryName));
  for (const expected of [
    "META-INF/container.xml",
    "OEBPS/content.opf",
    "OEBPS/book.xhtml",
    "OEBPS/book.smil",
    "OEBPS/nav.xhtml",
    "OEBPS/style.css",
    "OEBPS/audio/s1.mp3",
    "OEBPS/audio/s2.mp3",
    "OEBPS/audio/s3.mp3",
  ]) {
    assert.ok(names.has(expected), `missing ${expected}`);
  }
});

test("a paragraph in the third audio file gets clipBegin relative to that file's start", async () => {
  const outPath = path.join(root, "boundary.epub");
  await exportEpub(baseDir, outPath);
  const zip = new AdmZip(outPath);
  const pars = parseSmilPars(zip.readAsText("OEBPS/book.smil"));

  const ch3p1 = pars.find((p) => p.anchor === "ch3-p1");
  assert.ok(ch3p1, "ch3-p1 should be in the overlay");
  assert.equal(ch3p1?.audioSrc, "audio/s3.mp3");
  const wholeBookBegin = secs1 + secs2 + 0.2;
  const expectedClipBegin = wholeBookBegin - (secs1 + secs2);
  assert.ok(
    Math.abs((ch3p1?.clipBegin ?? Number.NaN) - expectedClipBegin) < 0.005,
    `expected clipBegin ~${expectedClipBegin}, got ${ch3p1?.clipBegin}`,
  );
});

test("pars are monotone (non-decreasing clipBegin) within each audio file", async () => {
  const outPath = path.join(root, "monotone.epub");
  await exportEpub(baseDir, outPath);
  const zip = new AdmZip(outPath);
  const pars = parseSmilPars(zip.readAsText("OEBPS/book.smil"));

  for (const file of ["audio/s1.mp3", "audio/s2.mp3", "audio/s3.mp3"]) {
    const begins = pars
      .filter((p) => p.audioSrc === file)
      .map((p) => p.clipBegin);
    const sorted = [...begins].sort((a, b) => a - b);
    assert.deepEqual(begins, sorted, `${file} pars are not monotone`);
  }
});

test("a par's clipEnd equals the next par's clipBegin in the same file, and the last par of a file has no clipEnd", async () => {
  const outPath = path.join(root, "clipend.epub");
  await exportEpub(baseDir, outPath);
  const zip = new AdmZip(outPath);
  const pars = parseSmilPars(zip.readAsText("OEBPS/book.smil"));

  const ch1p1 = pars.find((p) => p.anchor === "ch1-p1");
  const ch1p2 = pars.find((p) => p.anchor === "ch1-p2");
  assert.ok(ch1p1 && ch1p2);
  assert.equal(ch1p1?.clipEnd, ch1p2?.clipBegin);

  // ch1-p2 is the last paragraph in section 1's file — no clipEnd.
  assert.equal(ch1p2?.clipEnd, undefined);
  // ch3-p2 is the last paragraph overall (last of the last file) — also none.
  const ch3p2 = pars.find((p) => p.anchor === "ch3-p2");
  assert.equal(ch3p2?.clipEnd, undefined);
});

test("a paragraph with no phrase-0 row but a later phrase still appears, at its earliest phrase begin", async () => {
  const outPath = path.join(root, "nophrase0.epub");
  await exportEpub(baseDir, outPath);
  const zip = new AdmZip(outPath);
  const pars = parseSmilPars(zip.readAsText("OEBPS/book.smil"));

  // ch1-p2's rows are [2, 1.6, ...] and [1, 1.2, ...] — no row for phrase 0,
  // and the earliest begin (1.2) comes from phrase 1, not phrase 2.
  const ch1p2 = pars.find((p) => p.anchor === "ch1-p2");
  assert.ok(ch1p2, "ch1-p2 should still surface in the overlay");
  assert.equal(ch1p2?.audioSrc, "audio/s1.mp3");
  assert.ok(
    Math.abs((ch1p2?.clipBegin ?? Number.NaN) - 1.2) < 0.005,
    `expected clipBegin ~1.2, got ${ch1p2?.clipBegin}`,
  );
});

test("an anchor in the alignment that is not in book.html is skipped and counted in skipped", async () => {
  const outPath = path.join(root, "ghost.epub");
  const result = await exportEpub(baseDir, outPath);

  assert.equal(result.synced, 6);
  assert.equal(result.skipped, 1);

  const zip = new AdmZip(outPath);
  const pars = parseSmilPars(zip.readAsText("OEBPS/book.smil"));
  assert.ok(!pars.some((p) => p.anchor === "ghost-p1"));
});

test("refuses to export a failed verdict, quoting the refusal sentence, unless forced", async () => {
  const dir = await forkFixtureDir();
  const textSha256 = sha256(BOOK_HTML);
  const refusalSentence =
    "it aligned at median confidence 0.50; the bar is 0.8 — the recording and the text may have drifted apart.";
  const doc: Doc = {
    ...baseDoc,
    text: { file: "book.html", sha256: textSha256, paragraphs: 6 },
    alignment: {
      ...(baseDoc.alignment as NonNullable<Doc["alignment"]>),
      textSha256,
      verdict: {
        pass: false,
        docCoverage: 1.0,
        refusal: refusalSentence,
        gates: {
          minMedianConf: 0.8,
          minCoverage: 0.9,
          minDocCoverage: 0.5,
          maxLeadS: 125,
          maxEndGap: 0.05,
        },
      },
    },
  };
  await saveDoc(dir, doc);

  const outPath = path.join(dir, "out.epub");
  await assert.rejects(
    () => exportEpub(dir, outPath),
    (err: Error) => {
      assert.match(err.message, /alignment was refused/);
      assert.ok(err.message.includes(refusalSentence), err.message);
      return true;
    },
  );

  // { force: true } overrides the refusal and exports anyway.
  const result = await exportEpub(dir, outPath, { force: true });
  assert.equal(result.synced, 6);
});

test("throws 'text changed since alignment' when book.html is mutated after the doc was written", async () => {
  const dir = await forkFixtureDir();
  const textSha256 = sha256(BOOK_HTML);
  const doc: Doc = {
    ...baseDoc,
    text: { file: "book.html", sha256: textSha256, paragraphs: 6 },
    alignment: {
      ...(baseDoc.alignment as NonNullable<Doc["alignment"]>),
      textSha256,
    },
  };
  await saveDoc(dir, doc);

  // Mutate the text after the doc (and its hash) were committed.
  await writeFile(
    path.join(dir, "book.html"),
    `${BOOK_HTML}\n<!-- edited after alignment -->`,
  );

  await assert.rejects(
    () => exportEpub(dir, path.join(dir, "out.epub")),
    /text changed since alignment; re-run align/,
  );
});

test("throws an error naming the pipeline step for each missing doc field", async () => {
  const cases: {
    fields: (keyof Doc)[];
    expected: RegExp;
  }[] = [
    { fields: [], expected: /no book — run `import` first/ },
    { fields: ["book"], expected: /no text — run `import` first/ },
    {
      fields: ["book", "text"],
      expected: /no audio — run `fetch-audio` first/,
    },
    {
      fields: ["book", "text", "audio"],
      expected: /no alignment — run `align` first/,
    },
  ];

  for (const { fields, expected } of cases) {
    const dir = await mkdtemp(path.join(root, "missing-"));
    const doc: Doc = { format: "tale-align/v1", generator: "test" };
    if (fields.includes("book")) doc.book = baseDoc.book;
    if (fields.includes("text")) doc.text = baseDoc.text;
    if (fields.includes("audio")) doc.audio = baseDoc.audio;
    await saveDoc(dir, doc);

    await assert.rejects(
      () => exportEpub(dir, path.join(dir, "out.epub")),
      expected,
      `fields=${JSON.stringify(fields)}`,
    );
  }
});
