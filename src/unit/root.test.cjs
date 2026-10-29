const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveRoot } = require("../../out/features/comment/utils/root");

const fixture = (body) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "root-")));
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(home, "git"), { recursive: true });
  try {
    body({ base, home, git: path.join(home, "git") });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
};
const touch = (file, content = "x") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

test("a file in a repo root resolves to that repo", () => {
  fixture(({ home, git }) => {
    fs.mkdirSync(path.join(git, "repo", ".git"), { recursive: true });
    const file = touch(path.join(git, "repo", "a.ts"));
    assert.deepEqual(resolveRoot(file, home, undefined), {
      root: path.join(git, "repo"),
      relative: "a.ts",
    });
  });
});

test("a file in a repo subfolder resolves to the repo with a slash-separated relative path", () => {
  fixture(({ home, git }) => {
    fs.mkdirSync(path.join(git, "repo", ".git"), { recursive: true });
    const file = touch(path.join(git, "repo", "src", "deep", "a.ts"));
    assert.deepEqual(resolveRoot(file, home, path.join(git, "repo", "src")), {
      root: path.join(git, "repo"),
      relative: "src/deep/a.ts",
    });
  });
});

test("the nearest .git wins for a clone nested inside a parent repo", () => {
  fixture(({ home, git }) => {
    fs.mkdirSync(path.join(git, "RS", ".git"), { recursive: true });
    fs.mkdirSync(path.join(git, "RS", "cerebro", ".git"), { recursive: true });
    const file = touch(path.join(git, "RS", "cerebro", "x", "a.ts"));
    assert.deepEqual(resolveRoot(file, home, path.join(git, "RS")), {
      root: path.join(git, "RS", "cerebro"),
      relative: "x/a.ts",
    });
  });
});

test("a worktree whose .git is a file is its own root", () => {
  fixture(({ home, git }) => {
    fs.mkdirSync(path.join(git, "RS", ".git"), { recursive: true });
    touch(path.join(git, "RS", "cerebro_feat-x", ".git"), "gitdir: /elsewhere\n");
    const file = touch(path.join(git, "RS", "cerebro_feat-x", "a.ts"));
    assert.deepEqual(resolveRoot(file, home, path.join(git, "RS")), {
      root: path.join(git, "RS", "cerebro_feat-x"),
      relative: "a.ts",
    });
  });
});

test("under ~/git with no repo falls back to the workspace folder, else no root", () => {
  fixture(({ home, git }) => {
    const file = touch(path.join(git, "loose", "sub", "a.ts"));
    assert.deepEqual(resolveRoot(file, home, path.join(git, "loose")), {
      root: path.join(git, "loose"),
      relative: "sub/a.ts",
    });
    assert.equal(resolveRoot(file, home, undefined), undefined);
    assert.equal(resolveRoot(file, home, path.join(git, "other")), undefined);
  });
});

test("~/git itself is never a root unless it has a .git entry", () => {
  fixture(({ home, git }) => {
    const file = touch(path.join(git, "loose", "a.ts"));
    assert.equal(resolveRoot(file, home, undefined), undefined);
    fs.mkdirSync(path.join(git, ".git"));
    assert.deepEqual(resolveRoot(file, home, undefined), { root: git, relative: "loose/a.ts" });
  });
});

test("a .git above ~/git is ignored", () => {
  fixture(({ base, home, git }) => {
    fs.mkdirSync(path.join(base, ".git"));
    fs.mkdirSync(path.join(home, ".git"));
    const file = touch(path.join(git, "loose", "a.ts"));
    assert.equal(resolveRoot(file, home, undefined), undefined);
  });
});

test("outside ~/git uses the workspace folder, else no root", () => {
  fixture(({ base, home }) => {
    fs.mkdirSync(path.join(base, "proj", ".git"), { recursive: true });
    const file = touch(path.join(base, "proj", "src", "a.ts"));
    assert.deepEqual(resolveRoot(file, home, path.join(base, "proj")), {
      root: path.join(base, "proj"),
      relative: "src/a.ts",
    });
    assert.equal(resolveRoot(file, home, undefined), undefined);
    assert.equal(resolveRoot(file, home, path.join(base, "elsewhere")), undefined);
  });
});

test("a sibling ~/gitfoo is not under ~/git", () => {
  fixture(({ home }) => {
    fs.mkdirSync(path.join(home, "gitfoo", "repo", ".git"), { recursive: true });
    const file = touch(path.join(home, "gitfoo", "repo", "a.ts"));
    assert.equal(resolveRoot(file, home, undefined), undefined);
    assert.deepEqual(resolveRoot(file, home, path.join(home, "gitfoo")), {
      root: path.join(home, "gitfoo"),
      relative: "repo/a.ts",
    });
  });
});

test("a symlink inside ~/git pointing outside it is judged by its real path", () => {
  fixture(({ base, home, git }) => {
    fs.mkdirSync(path.join(base, "outside", "repo", ".git"), { recursive: true });
    touch(path.join(base, "outside", "repo", "a.ts"));
    fs.symlinkSync(path.join(base, "outside", "repo"), path.join(git, "link"));
    const viaLink = path.join(git, "link", "a.ts");
    assert.equal(resolveRoot(viaLink, home, undefined), undefined);
    assert.deepEqual(resolveRoot(viaLink, home, path.join(git, "link")), {
      root: path.join(git, "link"),
      relative: "a.ts",
    });
  });
});

test("a symlinked home resolves through its real path", () => {
  fixture(({ base, home, git }) => {
    fs.mkdirSync(path.join(git, "repo", ".git"), { recursive: true });
    const file = touch(path.join(git, "repo", "a.ts"));
    const linkHome = path.join(base, "homelink");
    fs.symlinkSync(home, linkHome);
    assert.deepEqual(resolveRoot(file, linkHome, undefined), {
      root: path.join(git, "repo"),
      relative: "a.ts",
    });
  });
});

test("paths with spaces resolve", () => {
  fixture(({ home, git }) => {
    fs.mkdirSync(path.join(git, "my repo", ".git"), { recursive: true });
    const file = touch(path.join(git, "my repo", "a dir", "my file.ts"));
    assert.deepEqual(resolveRoot(file, home, undefined), {
      root: path.join(git, "my repo"),
      relative: "a dir/my file.ts",
    });
  });
});

test("a file that does not exist yet still resolves", () => {
  fixture(({ home, git }) => {
    fs.mkdirSync(path.join(git, "repo", ".git"), { recursive: true });
    assert.deepEqual(resolveRoot(path.join(git, "repo", "new", "a.ts"), home, undefined), {
      root: path.join(git, "repo"),
      relative: "new/a.ts",
    });
  });
});

test("a file outside its workspace folder never yields a relative path starting with ..", () => {
  fixture(({ base, home }) => {
    const file = touch(path.join(base, "a", "x.ts"));
    assert.equal(resolveRoot(file, home, path.join(base, "b")), undefined);
    assert.equal(resolveRoot(file, home, path.join(base, "a", "x.ts")), undefined);
  });
});
