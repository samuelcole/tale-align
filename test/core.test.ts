import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LEAD_S,
  MAX_TAIL_S,
  MIN_COVERAGE,
  MIN_MEDIAN_CONF,
  gateRefusal,
  judge,
  paragraphs,
  rows,
  type WorkerOut,
} from "../src/core.ts";

// ---------------------------------------------------------------------------
// paragraphs()
// ---------------------------------------------------------------------------

test("paragraphs() extracts [id, text] pairs in document order", () => {
  const body =
    '<p id="p-z">First paragraph here</p><p id="p-a">Second paragraph here</p>';
  assert.deepEqual(paragraphs(body), [
    ["p-z", "First paragraph here"],
    ["p-a", "Second paragraph here"],
  ]);
});

test("paragraphs() strips inner tags from the paragraph text", () => {
  const body = '<p id="p1">Hello <em>brave</em> <strong>new</strong> world</p>';
  assert.deepEqual(paragraphs(body), [["p1", "Hello brave new world"]]);
});

test("paragraphs() decodes numeric entities", () => {
  const body = '<p id="p1">It&#8217;s a test</p>';
  assert.deepEqual(paragraphs(body), [["p1", "It’s a test"]]);
});

test("paragraphs() decodes &amp; &lt; &gt;", () => {
  const body = '<p id="p1">Fish &amp; chips &lt;tag&gt; end</p>';
  assert.deepEqual(paragraphs(body), [["p1", "Fish & chips <tag> end"]]);
});

test("paragraphs() replaces other named entities with a space", () => {
  const body = '<p id="p1">before &nbsp; and &mdash; after words</p>';
  // &nbsp; and &mdash; both collapse to whitespace, then whitespace itself
  // collapses, so this reads as one space-separated run.
  assert.deepEqual(paragraphs(body), [["p1", "before and after words"]]);
});

test("paragraphs() collapses whitespace runs (including newlines) to a single space", () => {
  const body = '<p id="p1">  lots   of\n\n  whitespace   here  </p>';
  assert.deepEqual(paragraphs(body), [["p1", "lots of whitespace here"]]);
});

test("paragraphs() drops paragraphs with fewer than 2 words", () => {
  const body =
    '<p id="empty"></p><p id="one-word">Solo</p><p id="two-words">Two words</p>';
  assert.deepEqual(paragraphs(body), [["two-words", "Two words"]]);
});

test("paragraphs() ignores <p> tags without an id attribute", () => {
  const body = '<p>No id, two words</p><p id="p1">Has id two words</p>';
  assert.deepEqual(paragraphs(body), [["p1", "Has id two words"]]);
});

test("paragraphs() returns an empty array when there are no anchored paragraphs", () => {
  assert.deepEqual(paragraphs("<div>no paragraphs at all</div>"), []);
});

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

// ---------------------------------------------------------------------------
// rows()
// ---------------------------------------------------------------------------

test("rows() flattens the phrases map to row objects with correct field mapping", () => {
  const phrases = {
    "anchor-1": [
      [0, 1.5, 0.9, 0] as [number, number, number, number],
      [1, 3.25, 0.8, 0] as [number, number, number, number],
    ],
    "anchor-2": [[0, 10.0, 0.95, 1] as [number, number, number, number]],
  };
  assert.deepEqual(rows(phrases), [
    {
      anchor_id: "anchor-1",
      phrase_index: 0,
      begin_secs: 1.5,
      confidence: 0.9,
      section: 0,
    },
    {
      anchor_id: "anchor-1",
      phrase_index: 1,
      begin_secs: 3.25,
      confidence: 0.8,
      section: 0,
    },
    {
      anchor_id: "anchor-2",
      phrase_index: 0,
      begin_secs: 10.0,
      confidence: 0.95,
      section: 1,
    },
  ]);
});

test("rows() returns an empty array for an empty phrases map", () => {
  assert.deepEqual(rows({}), []);
});
