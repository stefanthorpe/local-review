const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const OUT = "../../out/features/comment/utils/";
const { discoverReviewRoots } = require(OUT + "discover");

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "discover-")));
const repo = (dir) => {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".local-review"));
};

test("build and tool output folders are never entered", async () => {
  const work = tmp();
  try {
    for (const name of [
      "dist",
      "out",
      "build",
      ".vite",
      "coverage",
      ".next",
      ".vscode-test",
      "test-results",
    ]) {
      repo(path.join(work, name, "inner"));
    }
    repo(path.join(work, "real"));
    const { roots } = await discoverReviewRoots(work);
    assert.deepEqual(roots, [path.join(work, "real")]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("a .local-review five levels below the start is found, six is not", async () => {
  const work = tmp();
  try {
    repo(path.join(work, "a", "b", "c", "d"));
    repo(path.join(work, "a", "b", "c", "d", "e"));
    const { roots } = await discoverReviewRoots(work);
    assert.deepEqual(roots, [path.join(work, "a", "b", "c", "d")]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("the search stops after the folder cap and reports how many it visited", async () => {
  const work = tmp();
  try {
    for (let i = 0; i < 50; i++) {
      fs.mkdirSync(path.join(work, `d${i}`));
    }
    const result = await discoverReviewRoots(work, { maxDirs: 10 });
    assert.equal(result.stoppedAfter, 10);
    const full = await discoverReviewRoots(work);
    assert.equal(full.stoppedAfter, undefined);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("a symlinked folder is not followed", async () => {
  const work = tmp();
  const outside = tmp();
  try {
    repo(outside);
    fs.symlinkSync(outside, path.join(work, "link"));
    const { roots } = await discoverReviewRoots(work);
    assert.deepEqual(roots, []);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
