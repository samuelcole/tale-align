/** One alignment target: an anchored paragraph's id and its plain text. The id
 *  is the `<p id="…">` a reader deep links into, so it is also the key every
 *  timing the aligner emits comes back under. */
export type Fragment = [id: string, text: string];
