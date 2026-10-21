import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
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
