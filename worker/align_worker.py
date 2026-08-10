"""Forced-alignment worker — the per-book paragraph→audio-time aligner.

An audiobook and its text arrive with no timestamps between them, so this
worker generates the paragraph→time sync map. This is the compute core; the
tale-align CLI — or any other caller speaking the stdin/stdout JSON contract
below — feeds it a book and decides, from the confidence it returns, whether
the book ships read-along.

How it aligns (verified against the audio to ~10s, deep into a book — Dracula:
0.94 median confidence, 96% of paragraphs placed, spot-checked correct at
chapter 20+): a neural CTC forced aligner (torchaudio's MMS_FA) is accurate
inside a short window but drifts over a whole 37-minute section, and a book's
audio sections don't cleanly map to chapters (one section can hold several; a
chapter can straddle two; the reader skips epigraphs and announces "Chapter N"
mid-section). So we don't roll section-by-section. Instead, two global phases:

  * Phase 1 — anchor chain. Forward-pass the whole book once on the GPU (MPS
    when present, chunked so it stays fast and low-memory) into one emission.
    Then walk the text in fixed word-chunks; locate each chunk in the audio by a
    local search around its expected time, and a chunk that locks (sustained
    high score with a plausible speaking rate) becomes a monotone
    word→frame anchor. Un-narrated text (an epigraph, a heading, a mid-section
    announcement) simply fails to lock and is skipped — the next chunk
    self-corrects because it searches the same expected time. No per-section
    pointer to lose, so no runaway desync.
  * Phase 2 — fine-align. Inside each pair of bracketing anchors the span is
    short, so a bounded forced-align can't drift; each paragraph's BEGIN is its
    first word's begin frame (read-along needs the start; the next paragraph
    bounds it).

A book still ships only when its *median* paragraph confidence clears the
orchestrator's gate: a genuinely mis-aligned book (a narrated edition that drifts
from our text) reads low-median and stays honestly text-only. Individual
low-confidence rows can still be correct (numbers, names, and headings score low
even when placed right) — trust the book's median, not a single row.

We align at the WORD level and emit two cuts of the same data: `phrases` — one
begin per phrase, what the reader highlights today — and `words` — every word's
begin, the granularity-agnostic archive the orchestrator parks in Blob so any
future product call (coarser, finer, word-karaoke) is a re-derive, never a
days-long re-align.

I/O — a JSON job on stdin, the sync map as JSON on stdout (logs go to stderr):
  in:  {"frags": [["chapter-1-p1", "text of the paragraph"], ...],
        "sections": ["/tmp/…/0001.mp3", "/tmp/…/0002.mp3", ...],  # playing order
        "model": "wav2vec2"}  # optional; "wav2vec2" (MIT, default) or "mms_fa" (CC-BY-NC)
  out: {"phrases": {"chapter-1-p1": [[phrase_index, begin, conf, section], ...], ...},
        "words":   {"chapter-1-p1": [[begin, "word", conf], ...], ...},
        "meta": {"paras": N, "placed": M, "phrases": P, "median_conf": C,
                 "inversions": I, "audio_s": S, "sections": K, "device": "mps"}}

Env: python 3.12, torch + torchaudio (model weights auto-download on first
use: wav2vec2 ~360MB, MMS_FA ~1.2GB), soundfile, and ffmpeg on PATH. See
worker/requirements.txt.
"""

import atexit
import json
import os
import re
import subprocess
import sys
import time

import numpy as np
import soundfile as sf
import torch
import torchaudio

CH = 40 * 16000  # acoustic forward-pass chunk (40s) — fast, low-memory
CHUNK = 45  # phase-1 text step, in words
PROBE_S = 90  # phase-1 local-search probe window, in seconds
LOCK = 0.6  # phase-1 score to accept a chunk as an anchor
# A lost whole-book chain gets one stronger, bounded way back in: compare a
# forward window of text against the openings of the next few audio sections.
# Section boundaries are trustworthy time landmarks even when their titles do
# not map mechanically to ebook chapters. Requiring a higher score than an
# ordinary local lock keeps this recovery conservative.
RESYNC_LOCK = 0.75
RESYNC_SECTIONS = 4
RESYNC_TEXT_CHUNKS = 256
# Phase-2 window cap, in seconds of audio. A healthy inter-anchor gap is one
# CHUNK (~20s); when phase 1 skipped (unnarrated apparatus, a lost thread),
# the "gap" spans everything it skipped, and the aligner's trellis is
# frames × characters — so a sparse-anchor book OOM-kills the worker at ANY
# book size (the Tao Te Ching died at 1.6h of audio, 72 anchors over
# 38k words of mostly-unnarrated commentary). Text past an anchor's own
# locked chunk inside such a gap never locked in phase 1 and cannot honestly
# fine-align across minutes of unrelated audio; capping loses nothing that
# was ever placeable. 300s bounds the worst trellis near ~1 GB.
MAX_GAP_S = 300

# Per-process scratch (PID-tagged so two workers never clobber each other's).
WAVPATH = f"/tmp/_ab_{os.getpid()}.wav"
EMPATH = f"/tmp/_emission_{os.getpid()}.f16"


@atexit.register
def _cleanup() -> None:
    """Drop the on-disk emission (up to ~0.5 GB for a giant) whenever we exit."""
    for p in (WAVPATH, EMPATH):
        try:
            os.remove(p)
        except OSError:
            pass

job = json.load(sys.stdin)
# Two acoustic backends. The default is the MIT-licensed English wav2vec2 —
# weights auto-download from torchaudio's own hosting on first use, so the
# out-of-the-box pipeline is commercially clean end to end. MMS_FA (Meta's
# multilingual aligner, CC-BY-NC 4.0, trained specifically for alignment and
# usually somewhat stronger) is an explicit opt-in. An unknown request must
# fail loudly rather than silently align with the wrong acoustic model.
MODEL = job.get("model", "wav2vec2")
if MODEL not in ("wav2vec2", "mms_fa"):
    print(
        f"unknown model backend {MODEL!r}; supported: wav2vec2, mms_fa",
        file=sys.stderr,
    )
    sys.exit(2)
frags = [{"id": fid, "text": text} for fid, text in job["frags"]]
section_files = job["sections"]
# Giants (the orchestrator sets this for books too long to hold in RAM) stream
# the emission to a disk memmap; everything else keeps it resident, which is
# faster — a zero-copy slice per align vs a memmap read+cast. See build_emission.
STREAM = bool(job.get("stream"))

# Abbreviations that end in a period but don't end a phrase — so we don't split
# "Dr. Seward". A light guard; the word-level archive means an occasional odd
# split is re-derivable, never a re-align.
_ABBR = {"mr", "mrs", "ms", "dr", "st", "prof", "sr", "jr", "vs", "no", "mt"}
_MIN_PHRASE = 4  # merge shorter fragments into the previous one, so a comma in
# "red, white, and blue" doesn't spawn two-word highlights.


def phrases(text: str) -> list[str]:
    """Split a paragraph into phrases — the highlight unit (readbeyond-style,
    finer than a sentence so long sentences stay followable). Breaks on clause
    and sentence punctuation (. ? ! ; : , —), skips breaks after an abbreviation
    or single initial, and merges fragments below _MIN_PHRASE words forward."""
    out, buf = [], []
    toks = text.split()
    for k, tok in enumerate(toks):
        buf.append(tok)
        if tok[-1:] in ".?!;:,—" and k + 1 < len(toks):
            core = re.sub(r"[^a-z]", "", tok.lower())
            if tok[-1:] in ".?!;" and (core in _ABBR or len(core) <= 1):
                continue
            out.append(buf)
            buf = []
    if buf:
        out.append(buf)
    # merge short fragments into the previous phrase (or the next, for the first)
    merged: list[list[str]] = []
    for frag in out:
        if merged and len(frag) < _MIN_PHRASE:
            merged[-1].extend(frag)
        else:
            merged.append(frag)
    if len(merged) > 1 and len(merged[0]) < _MIN_PHRASE:
        first = merged.pop(0)
        merged[0][:0] = first  # prepend the short opener onto the next phrase
    return [" ".join(m) for m in merged] or [text]


# Flat word list; each word carries its paragraph index and its phrase index
# *within that paragraph*. The aligner works on words; we report paragraphs
# (phrase 0) and phrases (from these indices), and archive every word.
words: list[str] = []
wpar: list[int] = []
wphrase: list[int] = []
for i, fr in enumerate(frags):
    for j, phrase in enumerate(phrases(fr["text"])):
        for w in phrase.split():
            nw = re.sub(r"[^a-z']", "", w.lower())
            if nw:
                words.append(nw)
                wpar.append(i)
                wphrase.append(j)
W = len(words)

DEV = "mps" if torch.backends.mps.is_available() else "cpu"
# Half precision on the GPU ~1.7x the forward pass (the run's bottleneck) with no
# measurable hit to alignment — the emission is argmax-driven and we cast back to
# float32 for the CPU aligner. CPU stays fp32 (no half-kernel win there).
HALF = DEV == "mps"

# Both backends satisfy one contract the rest of the worker is written
# against: `tokenizer(words)` → per-word token-id lists, and
# `aligner(emission, tokens)` → per-word lists of spans carrying
# .start/.end/.score in frames. MMS_FA is a Wav2Vec2FABundle and ships both
# callables; WAV2VEC2_ASR_BASE_960H is an ASR bundle, so its two callables
# are built here from the model's own label set and torchaudio's
# forced_align. Everything downstream — chunked emission, the two phases,
# the gates — is backend-blind.
if MODEL == "mms_fa":
    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model().to(DEV)
    tokenizer = bundle.get_tokenizer()
    aligner = bundle.get_aligner()  # CTC align stays on CPU (tiny; no MPS kernel)
else:
    bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
    model = bundle.get_model().to(DEV)
    _labels = bundle.get_labels()  # ('-', '|', 'E', 'T', …, "'"); blank is 0
    _dic = {c: i for i, c in enumerate(_labels)}
    _SEP = _dic["|"]

    def tokenizer(ws):
        # Words arrive normalized to [a-z']; the ASR labels are uppercase.
        return [[_dic[c] for c in w.upper() if c in _dic] for w in ws]

    def aligner(emission, tokens):
        # The ASR model was trained emitting '|' at word boundaries, so the
        # targets carry separators — closer to its training distribution than
        # bare concatenation, and it sharpens word-begin frames.
        #
        # Those separators also mean the caller's frame budget (~1 frame per
        # character) undercounts by one per word, and CTC additionally needs
        # a blank frame between repeated letters ("ll"), so a sparse-anchor
        # gap that packs words right up to the window blows CTC's T ≥ L
        # invariant. Enforce feasibility here: keep only the words whose
        # full CTC cost fits the frames, exactly the trimming spirit of the
        # caller — a truncated tail never locked in phase 1 anyway.
        budget = emission.shape[0] - 8
        flat = [_SEP]
        cost = 1
        kept = 0
        for t in tokens:
            reps = sum(1 for a, b in zip(t, t[1:]) if a == b)
            word_cost = len(t) + 1 + reps
            if cost + word_cost > budget:
                break
            flat.extend(t)
            flat.append(_SEP)
            cost += word_cost
            kept += 1
        if kept == 0:
            return []
        tokens = tokens[:kept]
        log_probs = torch.log_softmax(emission.unsqueeze(0), dim=-1)
        targets = torch.tensor([flat], dtype=torch.int32)
        frames, scores = torchaudio.functional.forced_align(
            log_probs, targets, blank=0
        )
        # One merged span per target token, in target order; probabilities
        # (exp of log-probs) so scores land on the same 0..1 scale the MMS
        # aligner reports and the gates were calibrated on.
        spans = torchaudio.functional.merge_tokens(frames[0], scores[0].exp())
        out, k = [], 0
        for t in tokens:
            word_spans = []
            while k < len(spans) and len(word_spans) < len(t):
                if spans[k].token == _SEP:
                    k += 1
                    continue
                word_spans.append(spans[k])
                k += 1
            out.append(word_spans)
        return out


if HALF:
    model = model.half()


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _section_chunks():
    """Decode each section and yield its per-chunk MPS emissions [frames, tokens],
    plus a running total-samples count via the caller's list. One place for the
    ffmpeg/decode/forward-pass loop, so the RAM and streaming builders share it."""
    with torch.inference_mode():
        for path in section_files:
            # check=True so a decode failure raises instead of silently leaving a
            # stale wav behind — a corrupt emission would misalign the whole book.
            subprocess.run(
                ["ffmpeg", "-y", "-i", path, "-ar", "16000", "-ac", "1", WAVPATH],
                capture_output=True,
                check=True,
            )
            data, _ = sf.read(WAVPATH, dtype="float32")
            _section_chunks.samples += len(data)
            for s in range(0, len(data), CH):
                piece = data[s : s + CH]
                # The wav2vec2 feature convs need a real window; a tiny trailing
                # remainder (a few ms — sometimes a single sample) has no frames
                # to give and crashes the conv. Skipping it drops inaudible tail.
                if len(piece) < 640:
                    continue
                chunk = torch.from_numpy(piece).unsqueeze(0).to(DEV)
                if HALF:
                    chunk = chunk.half()
                em, _ = model(chunk)
                yield em[0], path


_section_chunks.samples = 0


def build_emission():
    """Forward-pass every section into the whole-book emission. In memory by
    default (a torch tensor — the aligner slices it zero-copy, which is the fast
    path for the ~99% of books that fit). For a giant (STREAM), write it to a
    float16 memmap on disk instead: phase 1 only ever reads a ~90s slice per lock,
    so a 50-hour, 9M-frame emission that would OOM if resident stays cheap. fp16
    loses nothing — the MPS pass is already fp16 and the aligner casts back.
    Returns (emission, ratio_secs_per_frame, section_frame_bounds, audio_secs)."""
    bounds = [0]
    prev = None  # so a section boundary lands after the section's last chunk
    if STREAM:
        frames = 0
        ntok = 0
        with open(EMPATH, "wb") as ef:
            for em, path in _section_chunks():
                if path != prev and prev is not None:
                    bounds.append(frames)
                prev = path
                arr = em.to(torch.float16).cpu().numpy()  # [frames, tokens]
                ntok = arr.shape[1]
                ef.write(arr.tobytes())
                frames += arr.shape[0]
        bounds.append(frames)
        emission = np.memmap(EMPATH, dtype=np.float16, mode="r", shape=(frames, ntok))
    else:
        ems = []
        for em, path in _section_chunks():
            if path != prev and prev is not None:
                bounds.append(sum(e.size(0) for e in ems))
            prev = path
            ems.append(em.float().cpu())  # aligner (CPU) wants float32
        bounds.append(sum(e.size(0) for e in ems))
        emission = torch.cat(ems, dim=0)
        frames = emission.size(0)
    total = _section_chunks.samples
    ratio = total / frames / 16000
    return emission, ratio, bounds, total / 16000


def align(emission, f0, f1, wi, we):
    """Forced-align words[wi:we] to emission[f0:f1]; return per-word
    (global_word_index, begin_frame, end_frame, score). Trims the word count so
    the CTC targets always fit the frame budget (~1 frame per character)."""
    f0, f1 = max(0, int(f0)), min(emission.shape[0], int(f1))
    we = min(we, len(words))  # callers pass a little slack (w1 + 2); don't overrun
    if f1 - f0 < 120 or we <= wi:
        return []
    avail = f1 - f0
    tot, end = 0, wi
    while end < we and tot < avail - 40:
        tot += len(words[end]) + 1
        end += 1
    we = max(wi + 1, min(we, end))
    if we <= wi:
        return []
    region = emission[f0:f1]
    # RAM path: a zero-copy torch view. Streaming path: pull the window off the
    # memmap and cast fp16→fp32 for the CPU aligner.
    sl = (
        region
        if torch.is_tensor(region)
        else torch.from_numpy(np.asarray(region, dtype=np.float32))
    )
    with torch.inference_mode():
        spans = aligner(sl, tokenizer(words[wi:we]))
    out = []
    for k, sp in enumerate(spans):
        score = sum(s.score * (s.end - s.start) for s in sp) / max(
            1, sum(s.end - s.start for s in sp)
        )
        out.append((wi + k, f0 + sp[0].start, f0 + sp[-1].end, score))
    return out


def probe(emission, ratio, f0, wi, n):
    """Score how well words[wi:wi+n] lock onto audio starting at frame f0.
    Combines mean word score with a speaking-rate plausibility check (a wrong
    lock crams or stretches the words to an implausible median gap)."""
    fps = 1 / ratio
    aw = align(emission, f0, f0 + int(PROBE_S * fps), wi, min(W, wi + n))
    if len(aw) < max(8, n // 2):
        return 0.0, aw
    scores = [s for *_, s in aw]
    gaps = sorted((aw[k + 1][1] - aw[k][1]) * ratio for k in range(len(aw) - 1))
    medgap = gaps[len(gaps) // 2]
    plaus = 1.0 if 0.12 <= medgap <= 0.6 else (0.5 if 0.08 <= medgap <= 0.9 else 0.15)
    return (sum(scores) / len(scores)) * plaus, aw


def resync_at_section(
    emission, ratio, bounds, text_start, time_start
) -> tuple[int, list] | None:
    """Find a strong monotone lock after the local phase-1 chain gets lost.

    The ordinary walk deliberately searches only near its expected time. That
    is fast and accurate while the chain is healthy, but a single long chapter
    or edition discontinuity can leave it unable to reach the next clean text:
    the old recovery advanced 315 ebook words for every 20 seconds of audio, so
    it could actually move farther from the diagonal.

    Audio-section starts are cheap, known landmarks. Probe the next few of them
    against a bounded text window beginning immediately after the last good
    anchor, then accept only a stronger-than-normal match. Both axes move
    forward, so the resulting anchor preserves the chain's monotonicity.
    """
    fps = 1 / ratio
    opening = text_start == 0 and time_start == 0
    # Include the zero-second boundary only when the chain has never locked.
    # Without it, an opening recovery can only begin at file 2 even when file 1
    # has a clean match after the LibriVox announcement. Later recovery keeps
    # its previous boundary set and strongest-match behavior.
    candidates = bounds[:-1] if opening else bounds[1:-1]
    section_starts = [
        b
        for b in candidates
        if b >= time_start - int(PROBE_S * fps)
    ][:RESYNC_SECTIONS]
    text_end = min(W - 5, text_start + RESYNC_TEXT_CHUNKS * CHUNK)

    # At the opening, prefer the earliest audio boundary with an independently
    # strong lock. Otherwise a slightly stronger later chapter can eclipse valid
    # earlier files (Worst Journey: file 3 eclipsed files 1 and 2, leaving a
    # 51-minute lead). Once a chain exists, retain the original highest-score
    # lookahead: changing that choice needlessly moved already-good interior
    # anchors in regression books. Both paths keep the stricter recovery
    # threshold and monotonicity on both axes.
    overall = (-1.0, None, None)  # (score, word index, aligned words)
    for section_start in section_starts:
        best = (-1.0, None, None)  # (score, word index, aligned words)
        # Begin just before the file boundary so a clipped word or a tiny
        # decoder/frame discrepancy cannot hide an otherwise clean opening.
        frame_start = max(time_start, section_start - int(3 * fps))
        for candidate in range(text_start, text_end, CHUNK):
            sc, aw = probe(emission, ratio, frame_start, candidate, CHUNK)
            if sc > best[0]:
                best = (sc, candidate, aw)
        score, candidate, aw = best
        if opening and score >= RESYNC_LOCK and candidate is not None and aw:
            return candidate, aw
        if score > overall[0]:
            overall = best
    score, candidate, aw = overall
    if score >= RESYNC_LOCK and candidate is not None and aw:
        return candidate, aw
    return None


def main():
    t0 = time.time()
    emission, ratio, bounds, audio_s = build_emission()
    t_emit = time.time()
    F = emission.shape[0]
    fps = 1 / ratio
    log(
        f"  emission {tuple(emission.shape)} for {audio_s:.0f}s audio on {DEV} "
        f"in {t_emit - t0:.0f}s ({'stream' if STREAM else 'ram'})"
    )

    # -------- Phase 1: build the monotone anchor chain --------
    anchors: list[tuple[int, int]] = []  # (word_index, precise begin frame)
    wi, t, skips = 0, 0, 0
    last_good_wi, last_good_t = 0, 0
    while wi < W - 5:
        best = (-1.0, None)  # (score, aligned_words)
        for df in range(int(-25 * fps), int(75 * fps), int(3 * fps)):
            ff = t + df
            if ff < 0 or ff + int(30 * fps) >= F:
                continue
            sc, aw = probe(emission, ratio, ff, wi, CHUNK)
            if sc > best[0]:
                best = (sc, aw)
        if best[0] >= LOCK and best[1]:
            aw = best[1]
            anchors.append((wi, aw[0][1]))
            t = aw[-1][2]  # expected-next = last aligned word's end
            wi += CHUNK
            skips = 0
            last_good_wi, last_good_t = wi, t
        else:
            wi += CHUNK
            skips += 1
            if skips > 6:  # lost the thread — try a structural re-lock
                recovered = resync_at_section(
                    emission, ratio, bounds, last_good_wi, last_good_t
                )
                if recovered:
                    recovered_wi, aw = recovered
                    anchors.append((recovered_wi, aw[0][1]))
                    t = aw[-1][2]
                    wi = recovered_wi + CHUNK
                    last_good_wi, last_good_t = wi, t
                    log(
                        f"  phase 1: re-locked at word {recovered_wi}/{W}, "
                        f"{aw[0][1] * ratio:.0f}s"
                    )
                else:
                    t += int(20 * fps)
                skips = 0
    t_p1 = time.time()
    log(f"  phase 1: {len(anchors)} anchors over {W} words in {t_p1 - t_emit:.0f}s")

    # -------- Phase 2: bounded fine-align between anchors --------
    byword: dict[int, tuple[int, int, float]] = {}
    if len(anchors) >= 2:
        for ai, (w0, f0) in enumerate(anchors):
            if ai + 1 < len(anchors):
                w1, f1 = anchors[ai + 1]
            else:
                w1, f1 = min(W, w0 + CHUNK), min(F, f0 + int(40 * fps))
            # The cap that keeps sparse-anchor gaps from OOMing the worker —
            # see MAX_GAP_S. align() already trims the word count to the
            # frame budget, so bounding the frames bounds the whole trellis.
            f1 = min(f1, f0 + int(MAX_GAP_S * fps))
            for g, bf, ef, sc in align(emission, f0, f1 + int(4 * fps), w0, w1 + 2):
                byword[g] = (bf, ef, sc)

    def section_of(frame: int) -> int:
        for si in range(len(bounds) - 1):
            if bounds[si] <= frame < bounds[si + 1]:
                return si + 1
        return len(bounds) - 1

    # Reshape the word alignment two ways from the same data:
    #   words[anchor]   — every aligned word, in order: the granularity-agnostic
    #                     archive, so any future cut (coarser, finer, or
    #                     word-karaoke) is a re-derive, never a re-align.
    #   phrases[anchor] — one begin per phrase (its first aligned word): the cut
    #                     the player renders today. Phrase 0 starts the paragraph.
    word_arch: dict[str, list] = {}
    for g in sorted(byword):
        bf, _ef, sc = byword[g]
        aid = frags[wpar[g]]["id"]
        word_arch.setdefault(aid, []).append([round(bf * ratio, 2), words[g], round(sc, 3)])

    # group aligned words by (paragraph, phrase) to get each phrase's start
    seen: dict[tuple[int, int], list[float]] = {}
    for g in sorted(byword):
        bf, _ef, sc = byword[g]
        key = (wpar[g], wphrase[g])
        if key not in seen:
            seen[key] = [bf, sc, 1]  # first word: begin frame, conf sum, count
        else:
            seen[key][1] += sc
            seen[key][2] += 1
    phrase_rows: dict[str, list] = {}
    phrase_confs: list[float] = []
    for (pi, pj), (bf, sc_sum, n) in sorted(seen.items()):
        aid = frags[pi]["id"]
        conf = round(sc_sum / n, 3)
        phrase_rows.setdefault(aid, []).append(
            [pj, round(bf * ratio, 2), conf, section_of(int(bf))]
        )
        phrase_confs.append(conf)

    real = [fr for fr in frags if len(fr["text"].split()) >= 2]
    placed = [fr for fr in real if fr["id"] in phrase_rows]
    confs = sorted(phrase_confs)
    med = confs[len(confs) // 2] if confs else 0.0

    # Coverage over the NARRATED SPAN, not the whole document. Prefaces,
    # introductions, glossaries, endnotes — anything the narrator skips at the
    # front or back — otherwise counts as "unplaced" and sinks a book whose
    # actual read text aligned fine (Beowulf: 86 verse paras placed, 55 prose
    # apparatus paras skipped → 61% whole-doc, but ~100% of what's narrated).
    # `lead`/`tail` guard the other failure: content that IS narrated but didn't
    # align leaves the first/last placed paragraph far from the audio's ends.
    def para_begin(aid: str) -> float:
        return min(r[1] for r in phrase_rows[aid])

    def para_end(aid: str) -> float:
        return max(
            ef * ratio
            for g, (_bf, ef, _sc) in byword.items()
            if frags[wpar[g]]["id"] == aid
        )

    span_cov, lead, tail = 0.0, audio_s, audio_s
    if placed:
        first_i, last_i = real.index(placed[0]), real.index(placed[-1])
        span_cov = len(placed) / (last_i - first_i + 1)
        lead = para_begin(placed[0]["id"])
        # Measure omitted audio after the final aligned word, not after the
        # beginning of its paragraph. A long final paragraph is fully narrated
        # content, not an apparent several-minute unaligned tail.
        tail = max(0.0, audio_s - para_end(placed[-1]["id"]))
        log(
            f"  span: {len(placed)}/{last_i - first_i + 1} placed in "
            f"[{placed[0]['id']}..{placed[-1]['id']}] "
            f"({100 * span_cov:.0f}%), lead {lead:.0f}s, tail {tail:.0f}s"
        )
    # monotonicity across all phrase begins in document order
    flat = [
        row[1]
        for fr in frags
        if fr["id"] in phrase_rows
        for row in sorted(phrase_rows[fr["id"]])
    ]
    inv = sum(1 for a, b in zip(flat, flat[1:]) if b < a - 1)
    total_t = time.time() - t0
    log(
        f"done: {audio_s:.0f}s audio in {total_t:.0f}s on {DEV} "
        f"({t_emit - t0:.0f}s emit + {t_p1 - t_emit:.0f}s phase1 + "
        f"{time.time() - t_p1:.0f}s phase2); "
        f"placed {len(placed)}/{len(real)} paras, {len(phrase_confs)} phrases, "
        f"median_conf {med:.2f}, inversions {inv}"
    )
    json.dump(
        {
            "phrases": phrase_rows,
            "words": word_arch,
            "meta": {
                "paras": len(real),
                "placed": len(placed),
                "span_coverage": round(span_cov, 3),
                "lead_s": round(lead, 1),
                "tail_s": round(tail, 1),
                "phrases": len(phrase_confs),
                "median_conf": med,
                "inversions": inv,
                "audio_s": round(audio_s),
                "sections": len(section_files),
                "device": DEV,
                "model": MODEL,
            },
        },
        sys.stdout,
    )


main()
