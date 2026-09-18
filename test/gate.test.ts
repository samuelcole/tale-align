import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gateRefusal,
  judge,
  MAX_END_GAP,
  MAX_LEAD_S,
  MIN_COVERAGE,
  MIN_MEDIAN_CONF,
} from "../src/gate.ts";
import type { WorkerOut } from "../src/types/WorkerOut.ts";

// ---------------------------------------------------------------------------
// judge()
// ---------------------------------------------------------------------------

/** A meta that clears every gate with room to spare. */
function passingMeta(
  overrides: Partial<WorkerOut["meta"]> = {},
): WorkerOut["meta"] {
  return {
    paras: 100,
    placed: 80,
    span_coverage: 0.95,
    lead_s: 10,
    tail_s: 10,
    start_gap: 0,
    end_gap: 0,
    phrases: 500,
    median_conf: 0.9,
    device: "cpu",
    ...overrides,
  };
}

test("judge() passes when all five gates clear", () => {
  const { pass, docCoverage } = judge(passingMeta());
  assert.equal(pass, true);
  assert.equal(docCoverage, 0.8);
});

test("judge() fails when median_conf is just below the gate", () => {
  const { pass } = judge(passingMeta({ median_conf: MIN_MEDIAN_CONF - 0.01 }));
  assert.equal(pass, false);
});

test("judge() fails when span_coverage is just below the gate", () => {
  const { pass } = judge(passingMeta({ span_coverage: MIN_COVERAGE - 0.01 }));
  assert.equal(pass, false);
});

test("judge() fails when placed/paras is just below the gate", () => {
  // 49/100 = 0.49, just under MIN_DOC_COVERAGE (0.5).
  const { pass, docCoverage } = judge(passingMeta({ placed: 49 }));
  assert.equal(docCoverage, 0.49);
  assert.equal(pass, false);
});

test("judge() fails when lead_s is just above the gate", () => {
  const { pass } = judge(passingMeta({ lead_s: MAX_LEAD_S + 0.01 }));
  assert.equal(pass, false);
});

test("judge() refuses to judge a worker that predates the ends measure", () => {
  const meta = passingMeta();
  delete meta.start_gap;
  delete meta.end_gap;
  assert.throws(() => judge(meta), /predates gate 0.6.0/);
});

test("judge() reads a nothing-placed null as the worst case", () => {
  const { pass } = judge(passingMeta({ start_gap: null, end_gap: null }));
  assert.equal(pass, false);
});

// ---------------------------------------------------------------------------
// the ends of the text (0.6.0)
// ---------------------------------------------------------------------------

const placedMeta = passingMeta;

test("judge() lets a long tail through once the narration is known to reach the text's end", () => {
  // Machiavelli's letters after The Prince: 87 minutes of audio past the
  // last paragraph, every paragraph of the text placed.
  const { pass } = judge(placedMeta({ tail_s: 5206 }));
  assert.equal(pass, true);
});

test("judge() still refuses a long lead — the opening is where the first lock is least certain", () => {
  const { pass } = judge(placedMeta({ lead_s: MAX_LEAD_S + 0.01 }));
  assert.equal(pass, false);
});

test("judge() refuses a narration that stops short of the text's end", () => {
  // The Idiot: volume one only, everything before it placed.
  const { pass } = judge(placedMeta({ placed: 51, end_gap: 0.49 }));
  assert.equal(pass, false);
});

test("judge() refuses a narration that starts too far into the text", () => {
  const { pass } = judge(placedMeta({ start_gap: 0.06 }));
  assert.equal(pass, false);
});

test("judge() passes a narration that starts and stops exactly on the 5% bars", () => {
  const { pass } = judge(placedMeta({ start_gap: 0.05, end_gap: 0.05 }));
  assert.equal(pass, true);
  assert.equal(MAX_END_GAP, 0.05);
});

test("judge() does not let the ends gate replace paragraph coverage", () => {
  // Reaches both ends but places only 40%: still a partial.
  const { pass } = judge(placedMeta({ placed: 40 }));
  assert.equal(pass, false);
});

test("gateRefusal() says where the narration stopped when that is the failing gate", () => {
  const meta = placedMeta({ end_gap: 0.49 });
  const { docCoverage } = judge(meta);
  const msg = gateRefusal(meta, docCoverage);
  assert.match(msg, /stops 49% short/);
  assert.match(msg, /5%/);
});

test("gateRefusal() says where the narration started when that is the failing gate", () => {
  const meta = placedMeta({ start_gap: 0.2 });
  const { docCoverage } = judge(meta);
  const msg = gateRefusal(meta, docCoverage);
  assert.match(msg, /starts 20% of the way/);
});

test("judge() passes when median_conf sits exactly on the gate (>=)", () => {
  const { pass } = judge(passingMeta({ median_conf: MIN_MEDIAN_CONF }));
  assert.equal(pass, true);
});

test("judge() passes when span_coverage sits exactly on the gate (>=)", () => {
  const { pass } = judge(passingMeta({ span_coverage: MIN_COVERAGE }));
  assert.equal(pass, true);
});

test("judge() passes when placed/paras sits exactly on the gate (>=)", () => {
  // 50/100 = 0.5 exactly.
  const { pass, docCoverage } = judge(passingMeta({ placed: 50 }));
  assert.equal(docCoverage, 0.5);
  assert.equal(pass, true);
});

test("judge() passes when lead_s sits exactly on the gate (<=)", () => {
  const { pass } = judge(passingMeta({ lead_s: MAX_LEAD_S }));
  assert.equal(pass, true);
});

test("judge() no longer has a tail gate: audio past the narrative is an appendix", () => {
  const { pass } = judge(passingMeta({ tail_s: 100_000 }));
  assert.equal(pass, true);
});

// ---------------------------------------------------------------------------
// gateRefusal()
// ---------------------------------------------------------------------------

test("gateRefusal() names median_conf's own value and the bar when it is the only failing gate", () => {
  const meta = passingMeta({ median_conf: 0.65 });
  const { docCoverage } = judge(meta);
  const msg = gateRefusal(meta, docCoverage);
  assert.match(msg, /0\.65/);
  assert.match(msg, /0\.8/);
});

test("gateRefusal() names span_coverage's percentage and the bar when it is the only failing gate", () => {
  const meta = passingMeta({ span_coverage: 0.5 });
  const { docCoverage } = judge(meta);
  const msg = gateRefusal(meta, docCoverage);
  assert.match(msg, /50%/);
  assert.match(msg, /90%/);
});

test("gateRefusal() names docCoverage's percentage and the bar when it is the only failing gate", () => {
  const meta = passingMeta({ placed: 20 }); // 20% doc coverage
  const { docCoverage } = judge(meta);
  const msg = gateRefusal(meta, docCoverage);
  assert.match(msg, /20%/);
  assert.match(msg, /50%/);
});

test("gateRefusal() names lead_s's own value and the bar when it is the only failing gate", () => {
  const meta = passingMeta({ lead_s: 200 });
  const { docCoverage } = judge(meta);
  const msg = gateRefusal(meta, docCoverage);
  assert.match(msg, /200/);
  assert.match(msg, /125/);
});

test("gateRefusal() names the end gap and the bar when it is the only failing gate", () => {
  const meta = passingMeta({ end_gap: 0.3 });
  const { docCoverage } = judge(meta);
  const msg = gateRefusal(meta, docCoverage);
  assert.match(msg, /30% short/);
  assert.match(msg, /5%/);
});

test("gateRefusal() returns median_conf's sentence first when median_conf and span_coverage both fail", () => {
  const meta = passingMeta({ median_conf: 0.5, span_coverage: 0.5 });
  const { docCoverage } = judge(meta);
  const msg = gateRefusal(meta, docCoverage);
  assert.match(msg, /median confidence/);
});

test("gateRefusal() returns span_coverage's sentence first when span_coverage and docCoverage both fail", () => {
  const meta = passingMeta({ span_coverage: 0.5, placed: 10 });
  const { docCoverage } = judge(meta);
  const msg = gateRefusal(meta, docCoverage);
  assert.match(msg, /matched paragraph lined up/);
});

test("gateRefusal() returns docCoverage's sentence first when docCoverage and lead_s both fail", () => {
  const meta = passingMeta({ placed: 10, lead_s: 200 });
  const { docCoverage } = judge(meta);
  const msg = gateRefusal(meta, docCoverage);
  assert.match(msg, /tale's paragraphs matched/);
});

test("gateRefusal() returns lead_s's sentence first when lead_s and the ends both fail", () => {
  const meta = passingMeta({ lead_s: 200, end_gap: 0.3 });
  const { docCoverage } = judge(meta);
  const msg = gateRefusal(meta, docCoverage);
  assert.match(msg, /before the first paragraph/);
});

test("gateRefusal() returns the start gap's sentence before the end gap's when both fail", () => {
  const meta = passingMeta({ start_gap: 0.2, end_gap: 0.3 });
  const { docCoverage } = judge(meta);
  const msg = gateRefusal(meta, docCoverage);
  assert.match(msg, /starts 20% of the way/);
});
