/** One section of a LibriVox recording, as the feed describes it — before any
 *  of it is on disk. `position` is renumbered 1..n in playing order. */
export type LibriVoxSection = {
  position: number;
  title: string | null;
  reader: string | null;
  listenUrl: string;
};

/** One LibriVox recording's identity and its sections, in playing order. */
export type LibriVoxRecording = {
  id: string;
  url: string;
  title: string;
  sections: LibriVoxSection[];
};
