import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "../src/sha256.ts";

test("sha256() is deterministic for the same input", () => {
  assert.equal(sha256("hello world"), sha256("hello world"));
});

test("sha256() returns a lowercase hex string of length 64", () => {
  assert.match(sha256("hello world"), /^[0-9a-f]{64}$/);
});

test("sha256() matches the known SHA-256 digest of a fixed string", () => {
  assert.equal(
    sha256("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("sha256() produces different digests for different inputs", () => {
  assert.notEqual(sha256("abc"), sha256("abd"));
});
