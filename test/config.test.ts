import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config, configFrom, VERSION } from "../src/config.ts";

test("VERSION is package.json's version — the one place it exists", async () => {
  const pkg = JSON.parse(
    await readFile(
      path.join(import.meta.dirname, "..", "package.json"),
      "utf8",
    ),
  ) as { version: string };
  assert.equal(VERSION, pkg.version);
});

test("configFrom() defaults: python3, 15h stream threshold, versioned UA", () => {
  const c = configFrom({});
  assert.equal(c.python, "python3");
  assert.equal(c.streamSecs, 54_000);
  assert.equal(
    c.ua,
    `tale-align/${VERSION} (+https://github.com/samuelcole/tale-align)`,
  );
});

test("configFrom() honors the environment", () => {
  const c = configFrom({
    ALIGN_PYTHON: "/venv/bin/python",
    TALE_ALIGN_STREAM_SECS: "7200",
    TALE_ALIGN_UA: "my-pipeline/1.0 (me@example.org)",
  });
  assert.equal(c.python, "/venv/bin/python");
  assert.equal(c.streamSecs, 7200);
  assert.equal(c.ua, "my-pipeline/1.0 (me@example.org)");
});

test("configFrom() refuses junk stream thresholds rather than adopting them", () => {
  assert.equal(
    configFrom({ TALE_ALIGN_STREAM_SECS: "soon" }).streamSecs,
    54_000,
  );
  assert.equal(configFrom({ TALE_ALIGN_STREAM_SECS: "-5" }).streamSecs, 54_000);
  assert.equal(configFrom({ TALE_ALIGN_STREAM_SECS: "" }).streamSecs, 54_000);
});

test("the process-wide config snapshot is frozen", () => {
  assert.ok(Object.isFrozen(config));
  assert.throws(() => {
    (config as { python: string }).python = "evil";
  }, TypeError);
});
