import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { gateRefusal, judge } from "../src/gate.ts";
import { runAligner } from "../src/runAligner.ts";
import type { Fragment } from "../src/types/Fragment.ts";

// The worker itself, against real speech. Everything else in this suite fakes
// the interpreter; this one needs the aligner's venv and the MMS_FA weights
// (~1.2 GB, cached on first use), so it runs only where ALIGN_PYTHON names
// that venv and skips everywhere else, CI included, saying why.
const python = process.env.ALIGN_PYTHON;
const skip = python
  ? false
  : "needs the aligner venv: set ALIGN_PYTHON to its interpreter";

const fixture = path.join(import.meta.dirname, "fixtures", "pinocchio-opening");

// Le avventure di Pinocchio as tale.fyi aligned it in production: Gutenberg
// 52484's title page and imprint (never read aloud), then the first paragraphs
// of chapter I, against the first 166 seconds of LibriVox 547's first track
// (public domain, re-encoded mono 24 kbps). The narrator reads the LibriVox
// announcement, the chapter title, then "C'era una volta" at 41.6s and "Un
// re!" at 43.5s. Phase 1 strides 45 words from word 0, so its first lock lands
// at word 45, inside "Un re!": before the lead-in, both opening paragraphs had
// no begin and the read-along started at "No, ragazzi" (TAL-407).
test("the opening story paragraphs before phase 1's first lock are aligned", {
  skip,
}, async () => {
  const frags = JSON.parse(
    await readFile(path.join(fixture, "frags.json"), "utf8"),
  ) as Fragment[];
  const { phrases } = await runAligner(
    frags,
    [path.join(fixture, "opening.mp3")],
    { python, model: "mms_fa", language: "it" },
  );
  const begin = (id: string) => phrases[id]?.find(([i]) => i === 0)?.[1];
  // Within a second of where the narrator says them.
  assert.ok(Math.abs((begin("i-p1") ?? 0) - 41.6) < 1, `i-p1 ${begin("i-p1")}`);
  assert.ok(Math.abs((begin("i-p2") ?? 0) - 43.5) < 1, `i-p2 ${begin("i-p2")}`);
  // The lead-in stops at text nobody reads: the title page stays unplaced.
  assert.deepEqual(
    Object.keys(phrases).filter((id) => id.startsWith("beginning-")),
    [],
  );
  // And what phase 1 already placed does not move.
  assert.ok(
    Math.abs((begin("i-p3") ?? 0) - 47.45) < 0.1,
    `i-p3 ${begin("i-p3")}`,
  );
});

const princess = path.join(
  import.meta.dirname,
  "fixtures",
  "little-princess-opening",
);

// A Little Princess as tale.fyi holds it: Burnett's preface (not read on this
// recording), then chapter I's first fourteen paragraphs, against the first
// 281 seconds of LibriVox's first track (public domain, re-encoded mono 24
// kbps). After the announcement and chapter title, the narrator starts "Once
// on a dark winter's day" at 15s. An unbracketed phase-1 probe for words
// 720 onward pulled its chunk back over the announcement and locked at 4s,
// ahead of everything before it: the read-along began at chapter-1-p4's fourth
// phrase, and the chapter's first paragraphs had no timing (TAL-407).
test("phase 1 does not lock a later chunk inside the announcement", {
  skip,
}, async () => {
  const frags = JSON.parse(
    await readFile(path.join(princess, "frags.json"), "utf8"),
  ) as Fragment[];
  const { phrases } = await runAligner(
    frags,
    [path.join(princess, "opening.mp3")],
    { python, model: "mms_fa", language: "en" },
  );
  const [first] = Object.keys(phrases);
  assert.equal(first, "chapter-1-p2", `first timed paragraph ${first}`);
  const begin = phrases["chapter-1-p2"]?.find(([i]) => i === 0)?.[1] ?? 0;
  assert.ok(Math.abs(begin - 15) < 1, `chapter-1-p2 begins ${begin}`);
  for (const id of ["chapter-1-p3", "chapter-1-p4"]) {
    assert.ok(
      phrases[id]?.some(([i]) => i === 0),
      `${id} has no phrase 0`,
    );
  }
});

const actBreak = path.join(
  import.meta.dirname,
  "fixtures",
  "master-builder-act-break",
);

// The Master Builder (Archer's translation) across its Act I/II file break:
// the last three minutes of LibriVox's dramatic reading of Act I, then the
// first five of Act II (public domain, re-encoded mono 24 kbps). Act II's file
// opens on its announcement and a cast list, about two minutes before the
// first line. That is longer than the section re-lock's probe window, and
// skipping text could not catch up: each lost streak moved 315 words for 20
// s of audio, so the walk ran off the end of the text with most of the
// book's audio unread. The full book was refused at 36% of its
// paragraphs (TAL-444).
test("phase 1 finds the text again after a long cast list", {
  skip,
}, async () => {
  const frags = JSON.parse(
    await readFile(path.join(actBreak, "frags.json"), "utf8"),
  ) as Fragment[];
  const { meta } = await runAligner(
    frags,
    [
      path.join(actBreak, "act-1-end.mp3"),
      path.join(actBreak, "act-2-start.mp3"),
    ],
    { python, model: "mms_fa", language: "en" },
  );
  assert.equal(meta.end_gap, 0, `end_gap ${meta.end_gap}`);
  assert.equal(
    meta.placed,
    frags.length,
    `placed ${meta.placed}/${frags.length}`,
  );
  assert.equal(meta.inversions, 0, `inversions ${meta.inversions}`);
});

const haggai = path.join(import.meta.dirname, "fixtures", "haggai-kjv");

// Haggai, King James Version, as tale.fyi holds it: Standard Ebooks' text
// against LibriVox's complete reading (public domain, re-encoded mono 24 kbps).
// Each phase-1 probe forced its 45 words into a 90 s window with nothing to
// take the speech around them, so CTC stretched the chunk's last words across
// the narration that followed; the walk set its expected-next mark at that
// smeared end, up to a minute late, so later chunks missed or locked late, and
// the book's last chunk was never probed at all. Haggai was refused for
// stopping a third short of its end, with all 24 of its paragraphs narrated
// (TAL-444).
// The same walk on the MIT wav2vec2 backend, whose CTC labels have no
// wildcard of their own: the worker appends one as a zero log-prob column.
test("phase 1 reaches the end of the book on wav2vec2 too", {
  skip,
}, async () => {
  const frags = JSON.parse(
    await readFile(path.join(haggai, "frags.json"), "utf8"),
  ) as Fragment[];
  const { meta } = await runAligner(frags, [path.join(haggai, "haggai.mp3")], {
    python,
    model: "wav2vec2",
    language: "en",
  });
  assert.equal(meta.model, "wav2vec2");
  assert.equal(meta.end_gap, 0, `end_gap ${meta.end_gap}`);
  assert.equal(
    meta.placed,
    frags.length,
    `placed ${meta.placed}/${frags.length}`,
  );
  assert.equal(meta.inversions, 0, `inversions ${meta.inversions}`);
  assert.ok(judge(meta).pass, gateRefusal(meta, judge(meta).docCoverage));
});

test("phase 1 reaches the end of the book, in order", {
  skip,
}, async () => {
  const frags = JSON.parse(
    await readFile(path.join(haggai, "frags.json"), "utf8"),
  ) as Fragment[];
  const { meta } = await runAligner(frags, [path.join(haggai, "haggai.mp3")], {
    python,
    model: "mms_fa",
    language: "en",
  });
  assert.equal(meta.end_gap, 0, `end_gap ${meta.end_gap}`);
  assert.equal(
    meta.placed,
    frags.length,
    `placed ${meta.placed}/${frags.length}`,
  );
  assert.equal(meta.inversions, 0, `inversions ${meta.inversions}`);
  assert.ok(judge(meta).pass, gateRefusal(meta, judge(meta).docCoverage));
});
