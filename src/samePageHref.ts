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
