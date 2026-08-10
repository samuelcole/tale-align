// The package's public surface: every module, re-exported under its own name.
// A file is named for its primary export, so this list is also the API index —
// and `tale-align/<name>` imports any one of them directly (see package.json's
// exports map) when a consumer wants the gate without the aligner's runtime.
//
// ./opf.ts is deliberately absent: it is shared internals of the two epub
// readers, not part of the API.

export { anchorText } from "./anchorText.ts";
export { type Config, config, configFrom, VERSION } from "./config.ts";
export { deepFreeze } from "./deepFreeze.ts";
export { download } from "./download.ts";
export { downloadSections } from "./downloadSections.ts";
export { epubIdentity } from "./epubIdentity.ts";
export { epubToAnchored } from "./epubToAnchored.ts";
export { exportEpub } from "./exportEpub.ts";
export { fetchGutenbergEpub } from "./fetchGutenbergEpub.ts";
export { fetchRecording } from "./fetchRecording.ts";
export {
  gateRefusal,
  judge,
  MAX_LEAD_S,
  MAX_TAIL_S,
  MIN_COVERAGE,
  MIN_DOC_COVERAGE,
  MIN_MEDIAN_CONF,
} from "./gate.ts";
export { loadDoc } from "./loadDoc.ts";
export { paragraphs } from "./paragraphs.ts";
export { probeSecs } from "./probeSecs.ts";
export { rows } from "./rows.ts";
export { runAligner, workerPath } from "./runAligner.ts";
export { GENERATOR, saveDoc } from "./saveDoc.ts";
export { samePageHref } from "./samePageHref.ts";
export { sha256 } from "./sha256.ts";
export { slugify } from "./slugify.ts";
export {
  DOC_FILE,
  type Doc,
  FORMAT,
  type GateConstants,
  type SectionEntry,
  type Source,
  type Verdict,
} from "./types/Doc.ts";
export type { Fragment } from "./types/Fragment.ts";
export type { GutenbergBook } from "./types/GutenbergBook.ts";
export type {
  LibriVoxRecording,
  LibriVoxSection,
} from "./types/LibriVoxRecording.ts";
export type { PhraseRow, WordRow, WorkerOut } from "./types/WorkerOut.ts";
