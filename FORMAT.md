# The tale-align interchange document (`tale-align/v1`)

One JSON file — `tale-align.json` — travels through the pipeline with a work
directory. Each stage adds its section and leaves the others alone:

| stage | command | writes |
| --- | --- | --- |
| 1 · acquire | `fetch-text` | `book.epub` on disk; `book` (identity + provenance); deletes stale `text`/`alignment` |
| 1 · acquire | `fetch-audio` | `audio/*.mp3` on disk; `audio`; deletes stale `alignment` |
| 1 · acquire | `prepare` | both halves, from local files |
| 2 · align | `align` | `text` (anchored from `book.epub` when not already present) and `alignment` |
| 3 · deliver | `export` | nothing — it only reads |

Stage 1's hand-off is deliberately just standard formats — an epub and
ordered MP3s — plus provenance in `book`; any source adapter can produce
it. Stage 2 mints the anchors and the timings. Stage 3 is any consumer of
the finished document: the bundled overlay-epub exporter, or something of
your own (tale.fyi's database loader consumes this same seam).

The document points at its bulky neighbors by relative path instead of
embedding them. The JSON is the map; the directory is the territory:

```
work/sleepy-hollow/
  tale-align.json
  book.epub            ← stage 1's untouched source epub
  book.html            ← stage 2's anchored text
  audio/0001.mp3 …     ← the recording, in playing order
```

## Top level

```jsonc
{
  "format": "tale-align/v1",     // required; consumers must refuse others
  "generator": "tale-align/0.1.0",
  "book":      { … },
  "text":      { … },
  "audio":     { … },
  "alignment": { … }
}
```

Fields are optional until their stage has run. Within `v1`, changes are
additive only — a consumer of `v1` never breaks on a newer document that
still says `v1`.

## `book`

```jsonc
{
  "title": "The Yellow Wallpaper",
  "author": "Charlotte Perkins Gilman",   // null when unknown
  "language": "en",
  "source": { "kind": "gutenberg", "id": "1952",
              "url": "https://www.gutenberg.org/ebooks/1952" }
}
```

`source` is provenance: enough to credit the text and fetch it again. `kind`
is open-ended (`gutenberg` today; anything tomorrow).

## `text`

```jsonc
{ "file": "book.html", "sha256": "…", "paragraphs": 214 }
```

`file` is **anchored HTML**: `<section id="…">` blocks whose every `<p>`
carries a stable `id` (e.g. `chapter-3-p14`). Those ids are the keys the
alignment is expressed in — they are the contract between the text, the
timings, and the exported epub's SMIL fragments. Ids must be unique in the
document and must survive any serialization a consumer applies (they are
plain slugs for that reason).

## `audio`

```jsonc
{
  "source": { "kind": "librivox", "id": "1712",
              "url": "https://librivox.org/…" },
  "sections": [
    { "position": 1, "file": "audio/0001.mp3", "secs": 1132.42,
      "title": "Part 1", "reader": "Some Narrator" }
  ]
}
```

Sections are the recording's files **in playing order**; `position` is
1-based. `secs` is the file's *measured* duration (ffprobe), not a catalog
estimate — the whole-book timeline below is cumulative over these values, so
a rounded catalog integer here would skew every later clip boundary.

## `alignment`

```jsonc
{
  "model": "wav2vec2",              // acoustic backend: "wav2vec2" | "mms_fa"
  "alignedAt": "2026-08-09T…Z",
  "textSha256": "…",              // hash of the text the times describe
  "phrases": { "<anchorId>": [[phraseIndex, beginSecs, confidence, section], …] },
  "words":   { "<anchorId>": [[beginSecs, "word", confidence], …] },
  "meta":    { "paras": …, "placed": …, "span_coverage": …, "lead_s": …,
               "tail_s": …, "phrases": …, "median_conf": …, "inversions": …,
               "audio_s": …, "sections": …, "device": "mps" },
  "verdict": {
    "pass": true,
    "docCoverage": 0.96,
    "refusal": null,              // on a fail: the first missed bar, in a sentence
    "gates": { "minMedianConf": 0.8, "minCoverage": 0.9,
               "minDocCoverage": 0.5, "maxLeadS": 125, "maxTailS": 120 }
  }
}
```

**Timeline.** All times are seconds into the *whole recording* — the
concatenation of the sections in order — with centisecond resolution. To
place a time inside a file, walk the cumulative `secs` (do not trust a row's
`section` column over the walk; a consumer that renders clips should derive
the file from the timeline, which is what the epub exporter does).

**`phrases`** is the render cut: one row per phrase of each anchored
paragraph, `phraseIndex` 0 being the paragraph's start. A paragraph the
narrator skipped has no rows at all — **absence is "unaligned"**, there are
no null placeholders.

**`words`** is the archive cut: every aligned word's begin time. Any future
granularity (coarser, finer, word karaoke) is a re-derive from this, never a
re-align.

**`textSha256`** binds the times to the exact text they were computed
against. A consumer must verify it before pairing this alignment with a text
file — an edited text with yesterday's timings is a mis-highlighting player,
the exact artifact this format exists to prevent.

**`verdict` is load-bearing.** Alignment is cheap to produce and easy to
produce *wrong*; the five gates (documented with their reasoning in
`src/core.ts`) decide whether this alignment is trustworthy enough to ship.
A document whose `verdict.pass` is `false` still carries its data — "tried,
refused, and here is which bar it missed" is a useful record — but a
consumer must not present it to a reader/listener as a working read-along.
The bars themselves ride along in `gates` so the verdict can be re-audited
later, even after the tool's defaults change.
