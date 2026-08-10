#!/usr/bin/env node
/**
 * tale-align — Gutenberg + LibriVox in, EPUB 3 Media Overlays out.
 *
 * Four commands, one work directory, one interchange document between them:
 *
 *   tale-align import       --gutenberg 1952 [--dir work/the-yellow-wallpaper]
 *   tale-align fetch-audio  --librivox 1712  --dir work/the-yellow-wallpaper
 *   tale-align align        --dir work/the-yellow-wallpaper [--python …] [--dry]
 *   tale-align export       --dir work/the-yellow-wallpaper [--out book.epub] [--force]
 *
 * Each stage reads `tale-align.json`, does its work, and writes it back;
 * `export` only ever reads. `align` records a verdict either way — the gates
 * deciding NOT to ship is a result, not an error — and `export` honors that
 * verdict unless forced. See FORMAT.md for the document the stages speak.
 */

import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  judge,
  MAX_LEAD_S,
  MAX_TAIL_S,
  MIN_COVERAGE,
  MIN_DOC_COVERAGE,
  MIN_MEDIAN_CONF,
  gateRefusal,
  paragraphs,
  STREAM_SECS,
} from "./core.ts";
import { exportEpub } from "./epub.ts";
import { type Doc, loadDoc, saveDoc, type SectionEntry, sha256 } from "./format.ts";
import {
  epubIdentity,
  epubToAnchored,
  fetchGutenbergEpub,
  slugify,
} from "./gutenberg.ts";
import { downloadSections, fetchRecording } from "./librivox.ts";
import { anchorText } from "./prepare.ts";
import { probeSecs, runAligner } from "./worker.ts";

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = argv.slice(1);

/** `--name value` or `--name=value`. */
function val(name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) {
    return eq.slice(name.length + 3);
  }
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("--")) {
    return args[i + 1];
  }
  return undefined;
}
const flag = (name: string) => args.includes(`--${name}`);

function need(name: string): string {
  const v = val(name);
  if (!v) {
    throw new Error(`--${name} is required (see tale-align --help)`);
  }
  return v;
}

const fmtSecs = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
};

/**
 * Stage 1, text half: fetch a source's epub and park it, untouched, as
 * `book.epub`. Stage 1 emits only standard formats (an epub, MP3s) so a
 * source adapter needs zero knowledge of this pipeline — Gutenberg today;
 * Standard Ebooks, unglue.it, anything tomorrow. The epub→anchored-text
 * conversion happens at `align`, whose contract the anchors belong to.
 */
async function cmdFetchText() {
  const id = need("gutenberg");
  process.stderr.write(`fetching Project Gutenberg #${id}…\n`);
  const epub = await fetchGutenbergEpub(id);
  const ident = epubIdentity(epub);
  const dir = val("dir") ?? path.join("work", slugify(ident.title));
  await mkdir(dir, { recursive: true });
  const doc = await loadDoc(dir);
  await writeFile(path.join(dir, "book.epub"), epub);
  doc.book = {
    ...ident,
    source: {
      kind: "gutenberg",
      id,
      url: `https://www.gutenberg.org/ebooks/${id}`,
    },
  };
  // The anchored text is derived from the epub at align time; a new epub
  // orphans both the derivation and any timings computed against it.
  delete doc.text;
  delete doc.alignment;
  await saveDoc(dir, doc);
  console.log(
    `✓ ${ident.title}${ident.author ? ` — ${ident.author}` : ""}\n  book.epub → ${dir}`,
  );
}

async function cmdFetchAudio() {
  const id = need("librivox");
  const dir = need("dir");
  const doc = await loadDoc(dir);
  process.stderr.write(`fetching LibriVox recording #${id}…\n`);
  const rec = await fetchRecording(id);
  await mkdir(path.join(dir, "audio"), { recursive: true });
  const sections = await downloadSections(rec, path.join(dir, "audio"));
  doc.audio = {
    source: { kind: "librivox", id, url: rec.url },
    sections,
  };
  delete doc.alignment; // new audio, stale times
  await saveDoc(dir, doc);
  const total = sections.reduce((s, x) => s + x.secs, 0);
  console.log(
    `✓ ${rec.title}\n  ${sections.length} sections, ${fmtSecs(total)} → ${dir}/audio/`,
  );
}

async function cmdPrepare() {
  const dir = need("dir");
  const textPath = val("text");
  const epubPath = val("epub");
  if (!textPath && !epubPath) {
    throw new Error("prepare needs --text <file.html|.txt> or --epub <file.epub>");
  }
  const audioDir = need("audio-dir");
  let body: string;
  let fromEpub: { title: string; author: string | null; language: string } | null =
    null;
  if (epubPath) {
    const book = epubToAnchored(await readFile(epubPath));
    body = book.body;
    fromEpub = book;
  } else {
    const raw = await readFile(textPath as string, "utf8");
    const kind = (textPath as string).toLowerCase().endsWith(".txt")
      ? "txt"
      : "html";
    body = anchorText(raw, kind);
  }
  const frags = paragraphs(body);
  if (frags.length === 0) {
    throw new Error(`${epubPath ?? textPath}: no paragraphs found to anchor`);
  }
  const files = (await readdir(audioDir))
    .filter((f) => /\.mp3$/i.test(f))
    .sort();
  if (files.length === 0) {
    throw new Error(`${audioDir}: no .mp3 files (playing order = filename sort)`);
  }
  await mkdir(path.join(dir, "audio"), { recursive: true });
  const doc = await loadDoc(dir);
  await writeFile(path.join(dir, "book.html"), body);
  const sourceFile = path.basename((epubPath ?? textPath) as string);
  const title =
    val("title") ?? fromEpub?.title ?? sourceFile.replace(/\.[a-z]+$/i, "");
  doc.book = {
    title,
    author: val("author") ?? fromEpub?.author ?? null,
    language: val("language") ?? fromEpub?.language ?? "en",
    source: { kind: "local", id: sourceFile, url: "" },
  };
  doc.text = { file: "book.html", sha256: sha256(body), paragraphs: frags.length };
  const sections: SectionEntry[] = [];
  for (const [i, f] of files.entries()) {
    const name = `${String(i + 1).padStart(4, "0")}.mp3`;
    const target = path.join(dir, "audio", name);
    await copyFile(path.join(audioDir, f), target);
    sections.push({
      position: i + 1,
      file: path.posix.join("audio", name),
      secs: await probeSecs(target),
      title: null,
      reader: val("reader") ?? null,
    });
  }
  doc.audio = {
    source: { kind: "local", id: path.basename(audioDir), url: "" },
    sections,
  };
  delete doc.alignment; // new inputs, stale times
  await saveDoc(dir, doc);
  const total = sections.reduce((s, x) => s + x.secs, 0);
  console.log(
    `✓ ${title}\n  ${frags.length} anchored paragraphs, ` +
      `${sections.length} audio files (${fmtSecs(total)}) → ${dir}`,
  );
}

async function cmdAlign() {
  const dir = need("dir");
  const doc = await loadDoc(dir);
  if (!doc.text) {
    // Stage 1 hands over a standard epub; anchoring is this stage's front
    // half, because the anchor ids the JSON is keyed on are the alignment's
    // contract with every downstream consumer.
    const data = await readFile(path.join(dir, "book.epub")).catch(() => null);
    if (!data) {
      throw new Error(
        `${dir}: no text — run \`tale-align fetch-text\` or \`prepare\` first`,
      );
    }
    const book = epubToAnchored(data);
    await writeFile(path.join(dir, "book.html"), book.body);
    doc.book ??= {
      title: book.title,
      author: book.author,
      language: book.language,
      source: { kind: "local", id: "book.epub", url: "" },
    };
    doc.text = {
      file: "book.html",
      sha256: sha256(book.body),
      paragraphs: paragraphs(book.body).length,
    };
    process.stderr.write(
      `anchored ${doc.text.paragraphs} paragraphs from book.epub\n`,
    );
  }
  if (!doc.audio || doc.audio.sections.length === 0) {
    throw new Error(`${dir}: no audio — run \`tale-align fetch-audio\` first`);
  }
  const html = await readFile(path.join(dir, doc.text.file), "utf8");
  const frags = paragraphs(html);
  if (frags.length === 0) {
    throw new Error(`${doc.text.file}: no anchored paragraphs`);
  }
  const totalSecs = doc.audio.sections.reduce((s, x) => s + x.secs, 0);
  const model = val("model") ?? "wav2vec2";
  process.stderr.write(
    `aligning ${frags.length} paragraphs to ${fmtSecs(totalSecs)} of audio (${model})…\n`,
  );
  const out = await runAligner(
    frags,
    doc.audio.sections.map((s) => path.join(dir, s.file)),
    {
      python: val("python"),
      stream: totalSecs > STREAM_SECS,
      model,
    },
  );
  const { pass, docCoverage } = judge(out.meta);
  console.log(
    `${pass ? "✓" : "·"} median ${out.meta.median_conf.toFixed(2)} (gate ${MIN_MEDIAN_CONF}), ` +
      `${out.meta.placed}/${out.meta.paras} placed (${(100 * docCoverage).toFixed(0)}%, ` +
      `gate ${100 * MIN_DOC_COVERAGE}%), span ${(100 * out.meta.span_coverage).toFixed(0)}% ` +
      `(gate ${100 * MIN_COVERAGE}%), lead ${out.meta.lead_s.toFixed(0)}s ` +
      `tail ${out.meta.tail_s.toFixed(0)}s → ${pass ? "ship" : "refused"}${flag("dry") ? " (dry)" : ""}`,
  );
  const refusal = pass ? null : gateRefusal(out.meta, docCoverage);
  if (refusal) {
    console.log(`  ${refusal}`);
  }
  if (flag("dry")) {
    return;
  }
  doc.alignment = {
    model,
    alignedAt: new Date().toISOString(),
    textSha256: sha256(html),
    phrases: out.phrases,
    words: out.words,
    meta: out.meta,
    verdict: {
      pass,
      docCoverage: Math.round(1000 * docCoverage) / 1000,
      refusal,
      gates: {
        minMedianConf: MIN_MEDIAN_CONF,
        minCoverage: MIN_COVERAGE,
        minDocCoverage: MIN_DOC_COVERAGE,
        maxLeadS: MAX_LEAD_S,
        maxTailS: MAX_TAIL_S,
      },
    },
  };
  await saveDoc(dir, doc);
  console.log(`  verdict recorded → ${dir}/tale-align.json`);
}

async function cmdExport() {
  const dir = need("dir");
  const doc: Doc = await loadDoc(dir);
  const out = path.resolve(
    val("out") ?? `${slugify(doc.book?.title ?? "book")}.epub`,
  );
  const summary = await exportEpub(dir, out, { force: flag("force") });
  console.log(
    `✓ ${out}\n  ${summary.synced} synced paragraphs across ${summary.sections} audio files, ` +
      `${fmtSecs(summary.totalSecs)}, narrated by ${summary.readers.join(", ") || "unknown"}` +
      `${summary.skipped ? `\n  (${summary.skipped} aligned anchors not present in the render — skipped)` : ""}`,
  );
}

const HELP = `tale-align — align public-domain audiobooks to their texts; export EPUB 3 Media Overlays

stage 1 — acquire (standard formats only: an epub + MP3s; swap in any source):
  tale-align fetch-text   --gutenberg <id> [--dir <workdir>]
  tale-align fetch-audio  --librivox <id>  --dir <workdir>
  tale-align prepare      --text <file.html|.txt> | --epub <file.epub>
                          --audio-dir <dir> --dir <workdir>
                          [--title T] [--author A] [--reader R] [--language en]
stage 2 — align (anchors the text, times every word, records the verdict):
  tale-align align        --dir <workdir> [--python <bin>] [--model wav2vec2|mms_fa] [--dry]
  tale-align export       --dir <workdir> [--out <file.epub>] [--force]

The aligner needs python + torch (see worker/requirements.txt) and ffmpeg on
PATH. Point --python (or ALIGN_PYTHON) at the venv's interpreter.
`;

try {
  if (cmd === "fetch-text") {
    await cmdFetchText();
  } else if (cmd === "fetch-audio") {
    await cmdFetchAudio();
  } else if (cmd === "prepare") {
    await cmdPrepare();
  } else if (cmd === "align") {
    await cmdAlign();
  } else if (cmd === "export") {
    await cmdExport();
  } else {
    process.stdout.write(HELP);
    process.exit(cmd && cmd !== "--help" ? 1 : 0);
  }
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
