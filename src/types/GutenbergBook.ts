/** A converted book: its identity, read from the epub's own OPF metadata, and
 *  its anchored body — `<section id>` blocks whose every `<p>` carries an
 *  explicit `id`. */
export type GutenbergBook = {
  title: string;
  author: string | null;
  language: string;
  body: string;
};
