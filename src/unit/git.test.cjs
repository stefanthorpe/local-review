const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runGit } = require("../../out/features/comment/utils/git");

test("runGit refuses on Windows without spawning git", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "git-win-"));
  const marker = path.join(bin, "ran");
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  process.env.PATH = bin;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    await assert.rejects(() => runGit(os.tmpdir(), ["--version"]), /Windows/);
  } finally {
    Object.defineProperty(process, "platform", platform);
    process.env.PATH = savedPath;
  }
  try {
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("runGit still runs git on other platforms", async () => {
  const { stdout } = await runGit(os.tmpdir(), ["--version"]);
  assert.match(stdout, /^git version/);
});
