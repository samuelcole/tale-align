/**
 * Arbitrary local inputs — the third front door. `import` speaks Project
 * Gutenberg and `fetch-audio` speaks LibriVox, but the pipeline's real
 * contract is just "anchored HTML + ordered MP3s", so any text and any
 * recording can enter here: a Standard Ebooks body, a self-recorded
 * narration, a plain .txt file.
 *
 * Text that already carries `<p id>` anchors passes through untouched — the
 * ids ARE the contract, and rewriting them would orphan whatever the caller
 * keyed on them. Anything else gets anchors baked, the way the Gutenberg
 * importer bakes them.
 *
 * Nothing here mutates a value it was handed; the one exception is the cheerio
 * DOM, whose API *is* mutation (`.attr()`), applied only to a tree this module
 * parsed itself and reads back out as a string.
 */

import * as cheerio from "cheerio";

const escText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function anchorText(input: string, kind: "html" | "txt"): string {
  if (kind === "txt") {
    const blocks = input
      .split(/\r?\n\s*\r?\n/)
      .map((b) => b.trim())
      .filter(Boolean);
    const ps = blocks.map(
      (b, i) =>
        `<p id="text-p${i + 1}">${escText(b).replace(/\r?\n/g, " ")}</p>`,
    );
    return `<section id="text">\n${ps.join("\n")}\n</section>`;
  }
  const $ = cheerio.load(input);
  if ($("p[id]").length > 0) {
    return input;
  }
  $("p").each((i, p) => {
    $(p).attr("id", `text-p${i + 1}`);
  });
  const body = $("body").html() ?? input;
  return $("section[id]").length > 0
    ? body
    : `<section id="text">\n${body}\n</section>`;
}
