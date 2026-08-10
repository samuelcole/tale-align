# tale-align

Align a public-domain audiobook to its text, word by word — and refuse to
ship the alignment unless it's trustworthy. Import a book from Project
Gutenberg and a recording from LibriVox, force-align them, and export a
standard **EPUB 3 with Media Overlays** that reads along in Thorium, Calibre,
and any other reader that honors overlays on reflowable books. (Apple Books
opens the epub but only engages read-aloud on fixed-layout books — a
platform limitation, not a property of the file.)

Extracted from — and dogfooded by — [tale.fyi](https://tale.fyi), where the
same pipeline drives the read-along player across hundreds of LibriVox
books.

> **Status: prototype.** The pipeline runs end to end; the edges are sharp.

## The stance: abstain rather than lie

Most text↔audio alignment tools transcribe the audio (Whisper), fuzzy-match
the transcript against the book, and always emit *something* — sometimes
subtly wrong. tale-align instead **forced-aligns** the text directly against
the audio's acoustics with a CTC model (wav2vec2 by default; Meta's `MMS_FA`
as an opt-in — see Licensing): one model, one error source, word timing
straight off the acoustic frames. The cost of that
choice is honesty about failure — a narrated edition that drifts from the
text, a recording whose opening never locks — so every alignment is judged
by five quality gates before it ships:

| gate | bar | catches |
| --- | --- | --- |
| median confidence | ≥ 0.8 | a genuinely wrong alignment |
| span coverage | ≥ 0.9 | holes between the first and last placed paragraph |
| document coverage | ≥ 0.5 | the "confidently wrong" partial lock |
| lead | ≤ 125s | a broken opening |
| tail | ≤ 120s | a broken ending |

A refusal is a first-class result: the verdict (and the bar it missed, in a
sentence) is recorded in the interchange document, and `export` will not
build an epub from a refused alignment. Better no read-along than one that
highlights the wrong paragraph.

## Three swappable stages

```
1 · acquire   any ebook source ──▶ book.epub          any audiobook source ──▶ audio/*.mp3
              (fetch-text: Gutenberg · fetch-audio: LibriVox · prepare: local files)
2 · align     book.epub + audio/ ──▶ book.html (anchored) + tale-align.json (times + verdict)
3 · deliver   tale-align.json ──▶ an EPUB 3 with Media Overlays (export, included)
                              ──▶ or your own consumer (a site's database loader, a player, …)
```

The seams are the design. Stage 1 emits **only standard formats** — an epub
and ordered MP3s — so a source adapter needs zero knowledge of this
pipeline: Gutenberg and LibriVox adapters are included, and Standard
Ebooks, unglue.it, or your own shelf are a small fetch script away
(`prepare` covers local files, including plain `.txt`). Stage 2 owns the
anchoring — the `<p id>` scheme the JSON is keyed on is the alignment's
contract with everything downstream — and text that already carries anchors
passes through untouched (that's how tale.fyi feeds its own stored books
through the library). Stage 3 is whatever consumes the interchange
document; the overlay epub exporter is the included sample, and tale.fyi
plugs its database loader in at the same seam.

Every stage speaks through one versioned JSON document — see
[FORMAT.md](FORMAT.md). The alignment itself is phrase- and word-level; the
epub is cut at paragraphs today, and a finer cut is a re-derive from the
stored words, never a re-align.

## Quickstart

Requirements: Node ≥ 22.18, Python 3.12, `ffmpeg` on PATH.

```sh
pnpm install && pnpm build

# the aligner's own venv (torch ~2GB; model weights auto-download on first run)
python3.12 -m venv .venv && .venv/bin/pip install -r worker/requirements.txt

node dist/cli.js fetch-text  --gutenberg 41  --dir work/sleepy-hollow
node dist/cli.js fetch-audio --librivox 428  --dir work/sleepy-hollow
node dist/cli.js align       --dir work/sleepy-hollow --python .venv/bin/python
node dist/cli.js export      --dir work/sleepy-hollow --out sleepy-hollow.epub
```

On Apple Silicon the forward pass runs on the Metal GPU (~100× realtime,
auto-detected); CPU aligns at ~20×.

## How the aligner works

Two global phases, no per-section state to lose (the worker's docstring in
[`worker/align_worker.py`](worker/align_worker.py) is the full story): a
whole-book CTC forward pass builds a monotone chain of word→frame anchors —
un-narrated text (a preface, a translator's note) simply fails to lock and
is skipped — then a bounded fine-align inside each anchor bracket recovers
every word's begin time. Books too long to hold in RAM stream their
emission to disk automatically.

## Licensing

The **code** is MIT, and so is the **default pipeline end to end**: the
default acoustic backend is `WAV2VEC2_ASR_BASE_960H` (MIT, English-only,
~360MB), so out of the box nothing in tale-align restricts commercial use.

No model weights ship in this repo. Each backend auto-downloads from
torchaudio's own hosting on first use:

| backend | license | scope | weights |
| --- | --- | --- | --- |
| `wav2vec2` (default) | MIT | English | ~360MB |
| `mms_fa` (`--model mms_fa`) | **CC-BY-NC 4.0** | 1,100+ languages, trained for alignment, usually stronger | ~1.2GB |

Choosing `--model mms_fa` is choosing Meta's non-commercial license — a
deliberate, per-run opt-in, never a default you inherit. Be honest with
yourself about the tradeoff: the default abstains noticeably more often. In
our testing, one recording that MMS_FA ships at median 0.96 with every
paragraph placed collapses below the gate on wav2vec2. That is the system
working — the gates judge each result on its own merits, and a book the
weaker model can't align confidently gates to text-only instead of shipping
wrong highlights — but if your pipeline is non-commercial, `--model mms_fa`
will rescue books the default refuses.

Texts from Project Gutenberg are imported with all Project Gutenberg
trademarks and boilerplate stripped, as their license requires of
redistributed plain public-domain text. LibriVox recordings are public
domain; the exported epub credits the narrators (`marc:relators` "nrt") and
carries both sources in `dc:source`.

## Colophon

Extracted from [tale.fyi](https://tale.fyi)'s production read-along
pipeline and built agentically: the stage boundaries, interchange format,
and interface contracts were specified in-session; the mechanical ports ran
as parallel model agents against those contracts; every diff was reviewed
before it landed. Verification is the spine of that process — epubcheck on
every export, boundary forensics comparing two independent derivations of
clip-to-file attribution, and real-reader QA in Thorium. The same process
caught two real bugs on the way out: a Gutenberg conversion that silently
dropped a split epub's opening chapter (the generator names the whole first
content file `pg-header`), and an exporter rule that dropped any paragraph
whose opening phrase never locked. Both are fixed here; the first is
tracked for the upstream importer too.
