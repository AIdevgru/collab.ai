import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { expand, globToRegExp, intersect, matchAny } from "../../skills/collab/lib/glob.mjs";

// [glob, paths that match, paths that don't]
const CASES = [
  ["*.js", ["a.js", ".eslintrc.js", "x.y.js"], ["dir/a.js", "a.jsx", "a.ts"]],
  ["src/*.js", ["src/a.js"], ["src/x/a.js", "a.js", "srcx/a.js"]],
  ["src/**", ["src", "src/a", "src/x/y.js"], ["srcx/a", "lib/src/a"]],
  ["src/", ["src/a.js", "src/deep/b.js"], ["srcx/a.js"]],
  ["**/test.js", ["test.js", "a/test.js", "a/b/test.js"], ["atest.js", "a/test.jsx"]],
  ["a/**/b", ["a/b", "a/x/b", "a/x/y/b"], ["a/xb", "ab", "a/b/c"]],
  ["**", ["a", "a/b/c.js", ".git/x"], []],
  ["**/*.md", ["README.md", "docs/a/b.md"], ["README.mdx", "docs/a.txt"]],
  ["src/**/*.test.mjs", ["src/a.test.mjs", "src/x/y/a.test.mjs"], ["src/a.mjs", "tests/a.test.mjs"]],
  ["a**b", ["ab", "axxb"], ["a/b", "ax/xb"]],
  ["?.js", ["a.js", "1.js"], ["ab.js", ".js", "/.js"]],
  ["src/?/x", ["src/a/x"], ["src//x", "src/ab/x"]],
  ["{a,b}.js", ["a.js", "b.js"], ["c.js", "ab.js", "{a,b}.js"]],
  ["src/{lib,util}/*.{js,mjs}", ["src/lib/a.js", "src/util/b.mjs"], ["src/core/a.js", "src/lib/a.ts"]],
  ["{src/**/*.ts,test/*.ts}", ["src/a.ts", "src/x/a.ts", "test/a.ts"], ["test/x/a.ts", "lib/a.ts"]],
  ["{*.md,docs/**}", ["README.md", "docs/a/b.txt"], ["src/a.md"]],
  ["{a,{b,c}}.txt", ["a.txt", "b.txt", "c.txt"], ["d.txt"]],
  ["{**/x,y}", ["x", "a/b/x", "y"], ["a/y"]],
  ["[abc].js", ["a.js", "c.js"], ["d.js", "ab.js"]],
  ["[a-c]x", ["bx"], ["dx"]],
  ["[!a].js", ["b.js"], ["a.js", "/.js"]],
  ["[^a].js", ["b.js"], ["a.js"]],
  ["[]a].js", ["].js", "a.js"], ["b.js"]],
  ["a.b+c(1)$^|.js", ["a.b+c(1)$^|.js"], ["aXb+c(1)$^|.js", "abbc1.js"]],
  ["file.js", ["file.js"], ["fileXjs", "file.jsx"]],
  ["\\*.js", ["*.js"], ["a.js"]],
  ["a\\{b,c\\}", ["a{b,c}"], ["ab", "ac"]],
  ["a[b", ["a[b"], ["ab"]],
  ["{a", ["{a"], ["a"]],
  ["{a}", ["{a}"], ["a"]],
  ["a,b", ["a,b"], ["a", "b"]],
  ["src/truncate.*", ["src/truncate.js", "src/truncate.test.js"], ["src/truncate/x.js", "src/truncatex"]],
  ["./src/*.js", ["src/a.js", "./src/a.js"], ["a.js"]],
  ["/root.txt", ["root.txt"], ["a/root.txt"]],
];

describe("globToRegExp", () => {
  for (const [glob, yes, no] of CASES) {
    test(`${glob}`, () => {
      for (const p of yes) assert.ok(matchAny([glob], p), `${glob} should match ${p}`);
      for (const p of no) assert.ok(!matchAny([glob], p), `${glob} should not match ${p}`);
    });
  }

  test("returns an anchored RegExp", () => {
    const re = globToRegExp("src/*.js");
    assert.ok(re instanceof RegExp);
    assert.ok(re.test("src/a.js"));
    assert.ok(!re.test("x/src/a.js"));
    assert.ok(!re.test("src/a.jsx"));
  });

  test("returns a fresh RegExp each time", () => {
    assert.notEqual(globToRegExp("a"), globToRegExp("a"));
  });

  test("rejects a non-string glob", () => {
    assert.throws(() => globToRegExp(null), TypeError);
  });
});

describe("matchAny", () => {
  test("true when any glob matches", () => {
    assert.equal(matchAny(["*.md", "src/**"], "src/a/b.js"), true);
    assert.equal(matchAny(["*.md", "src/**"], "lib/a.js"), false);
  });
  test("an empty or missing list matches nothing", () => {
    assert.equal(matchAny([], "a"), false);
    assert.equal(matchAny(undefined, "a"), false);
  });
});

describe("expand", () => {
  const files = ["README.md", "src/a.js", "src/b.ts", "src/x/c.js", "test/a.test.js"];
  test("keeps file order and drops duplicates", () => {
    assert.deepEqual(expand(["src/**/*.js", "src/*.js"], files), ["src/a.js", "src/x/c.js"]);
  });
  test("several globs", () => {
    assert.deepEqual(expand(["*.md", "test/**"], files), ["README.md", "test/a.test.js"]);
  });
  test("no globs or no files gives nothing", () => {
    assert.deepEqual(expand([], files), []);
    assert.deepEqual(expand(["**"], []), []);
  });
});

describe("intersect", () => {
  const all = ["src/a.js", "src/b.js", "src/lib/c.js", "docs/x.md", "README.md"];
  const T = [
    // [name, aGlobs, aFiles, bGlobs, bFiles, expected]
    ["glob vs glob through existing files", ["src/**"], [], ["src/*.js"], [], ["src/a.js", "src/b.js"]],
    ["disjoint scopes", ["src/**"], [], ["docs/**"], [], []],
    ["a touched file inside the other scope", ["docs/**"], ["src/lib/c.js"], ["src/lib/**"], [], ["src/lib/c.js"]],
    ["touched files on both sides", [], ["x/new.js"], [], ["x/new.js"], ["x/new.js"]],
    ["a new literal file against a glob", ["src/new.js"], [], ["src/*.js"], [], ["src/new.js"]],
    ["a glob against a new literal file", ["src/*.js"], [], ["src/new.js"], [], ["src/new.js"]],
    ["two equal literal new files", ["lib/n.ts"], [], ["lib/n.ts"], [], ["lib/n.ts"]],
    ["brace literals name new files", ["src/{p,q}.js"], [], ["src/q.*"], [], ["src/q.js"]],
    ["a literal outside the other glob", ["lib/new.js"], [], ["src/**"], [], []],
    ["glob vs glob with no concrete file is not detected", ["new/*.ts"], [], ["new/**"], [], []],
    ["empty scopes never overlap", [], [], ["**"], [], []],
    ["result is sorted and unique", ["**/*.js"], ["src/b.js"], ["src/**"], ["src/a.js"], ["src/a.js", "src/b.js", "src/lib/c.js"]],
    ["missing arguments are treated as empty", undefined, undefined, ["**"], undefined, []],
  ];
  for (const [name, aG, aF, bG, bF, want] of T) {
    test(name, () => {
      assert.deepEqual(intersect(aG, aF, bG, bF, all), want);
      assert.deepEqual(intersect(bG, bF, aG, aF, all), want, "intersect is symmetric");
    });
  }
});
