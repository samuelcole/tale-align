import { test } from "node:test";
import assert from "node:assert/strict";
import { rows } from "../src/rows.ts";

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
