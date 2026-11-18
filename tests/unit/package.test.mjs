import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

test("package is a zero-dependency ES module CLI named collab", () => {
  assert.equal(pkg.type, "module");
  assert.equal(pkg.bin.collab, "skills/collab/bin/collab.mjs");
  assert.equal(pkg.dependencies, undefined);
  assert.match(pkg.engines.node, />=22/);
});

test("the skill's VERSION matches package.json", async () => {
  const { VERSION } = await import("../../skills/collab/lib/version.mjs");
  const pkg = JSON.parse((await import("node:fs")).readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, pkg.version);
});
