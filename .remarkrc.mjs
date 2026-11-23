// Markdown formatting for README.md and FORMAT.md. Biome formats the code;
// remark formats the prose around it and never touches a fenced block's
// contents, so the hand-aligned examples in FORMAT.md keep their shape. The
// settings match how these files are already written.
import remarkGfm from "remark-gfm";

// With single-tilde strikethrough off, a lone `~` (as in "~70×") is plain
// text, but remark still escapes it to `\~`. Drop that escape rule.
function keepLoneTildes() {
  const withoutTilde = (extension) => ({
    ...extension,
    unsafe: extension.unsafe?.filter((rule) => rule.character !== "~"),
    extensions: extension.extensions?.map(withoutTilde),
  });
  const data = this.data();
  data.toMarkdownExtensions = data.toMarkdownExtensions.map(withoutTilde);
}

export default {
  settings: {
    bullet: "*",
    emphasis: "*",
    strong: "*",
    rule: "-",
    listItemIndent: "one",
    fences: true,
    incrementListMarker: true,
  },
  plugins: [[remarkGfm, { singleTilde: false }], keepLoneTildes],
};
