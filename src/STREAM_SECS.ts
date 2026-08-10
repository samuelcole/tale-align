/**
 * Above this length, the worker streams its emission to a disk memmap instead of
 * holding it in RAM — otherwise a 20h+ book's whole emission plus its phase-1
 * search exhausts memory and the OS kills it (An Autobiography, 21.8h, used to
 * climb for an hour then die). Streaming is somewhat slower per book (a memmap
 * read + cast per align vs a zero-copy slice), so only the giants pay it;
 * everything under 15h stays resident and fast. 15h is twice the longest book
 * that aligns comfortably in RAM.
 *
 * One constant, one file, on purpose. It is a *decision about a job*, not part
 * of the machinery that runs one: pure consumers (tale.fyi's route bundle among
 * them) read it to size a job they never spawn, and ./runAligner.ts — the only
 * module that would otherwise host it — drags `node:child_process` in with it.
 */
export const STREAM_SECS = 54_000;
