import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gateRefusal,
  judge,
  MAX_LEAD_S,
  MAX_TAIL_S,
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

test("judge() fails when tail_s is just above the gate", () => {
  const { pass } = judge(passingMeta({ tail_s: MAX_TAIL_S + 0.01 }));
  assert.equal(pass, false);
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

test("judge() passes when tail_s sits exactly on the gate (<=)", () => {
  const { pass } = judge(passingMeta({ tail_s: MAX_TAIL_S }));
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

test("gateRefusal() names tail_s's own value and the bar when it is the only failing gate", () => {
  const meta = passingMeta({ tail_s: 300 });
  const { docCoverage } = judge(meta);
  const msg = gateRefusal(meta, docCoverage);
  assert.match(msg, /300/);
  assert.match(msg, /120/);
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

test("gateRefusal() returns lead_s's sentence first when lead_s and tail_s both fail", () => {
  const meta = passingMeta({ lead_s: 200, tail_s: 300 });
  const { docCoverage } = judge(meta);
  const msg = gateRefusal(meta, docCoverage);
  assert.match(msg, /before the first paragraph/);
});

test("gateRefusal() returns tail_s's sentence when it is the last remaining failing gate", () => {
  const meta = passingMeta({ tail_s: 300 });
  const { docCoverage } = judge(meta);
  const msg = gateRefusal(meta, docCoverage);
  assert.match(msg, /after the last paragraph/);
});
