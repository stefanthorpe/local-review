const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { withProvider, withHome } = require("./provider-harness.cjs");

// Git for fixtures ignores the caller's GIT_* variables and the machine's global, system and XDG
// config, so a global ignore of .local-review/ cannot change what these tests see.
const git = (cwd, ...args) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_CONFIG_NOSYSTEM = "1";
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    env,
    stdio: "ignore",
  });
};

const withRealRepo = async (body, options = {}) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "provider-ignore-")));
  const repo = path.join(home, "git", "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  git(repo, "init", "-q");
  const filePath = path.join(repo, "src", "a.ts");
  fs.writeFileSync(filePath, "line\n");
  try {
    await withHome(home, () =>
      withProvider((ctx) => body({ ...ctx, home, repo }), {
        filePath,
        noWorkspace: true,
        input: "fix this",
        ...options,
      }),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
};

test("a repo that already ignores .local-review/ gets no prompt", async () => {
  await withRealRepo(async ({ repo, provider, editor, prompts }) => {
    fs.writeFileSync(path.join(repo, ".gitignore"), ".local-review/\n");
    await provider.startCommentAtLine(editor.document.uri, 0);
    assert.deepEqual(prompts, []);
  });
});

test("an unignored repo is asked by name and Add writes the private exclude, not .gitignore", async () => {
  await withRealRepo(
    async ({ repo, provider, editor, prompts, warnings }) => {
      await provider.startCommentAtLine(editor.document.uri, 0);
      assert.deepEqual(prompts, ["Ignore .local-review/ in repo?"]);
      assert.deepEqual(warnings, []);
      assert.equal(
        fs
          .readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8")
          .split("\n")
          .includes(".local-review/"),
        true,
      );
      assert.equal(fs.existsSync(path.join(repo, ".gitignore")), false);
    },
    { answer: "Add" },
  );
});

test("declining the prompt writes nothing", async () => {
  await withRealRepo(async ({ repo, provider, editor, prompts }) => {
    await provider.startCommentAtLine(editor.document.uri, 0);
    assert.equal(prompts.length, 1);
    assert.equal(fs.existsSync(path.join(repo, ".gitignore")), false);
    assert.doesNotMatch(
      fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8"),
      /local-review/,
    );
  });
});

test("a worktree writes the exclude into the common git dir", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "provider-wt-")));
  try {
    const main = path.join(home, "git", "main");
    const wt = path.join(home, "git", "wt");
    fs.mkdirSync(main, { recursive: true });
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "-q", wt, "-b", "feature");
    assert.ok(fs.statSync(path.join(wt, ".git")).isFile());
    const filePath = path.join(wt, "a.ts");
    fs.writeFileSync(filePath, "line\n");
    await withHome(home, () =>
      withProvider(
        async ({ provider, editor, prompts }) => {
          await provider.startCommentAtLine(editor.document.uri, 0);
          assert.deepEqual(prompts, ["Ignore .local-review/ in wt?"]);
          assert.match(
            fs.readFileSync(path.join(main, ".git", "info", "exclude"), "utf8"),
            /^\.local-review\/$/m,
          );
          assert.equal(fs.existsSync(path.join(wt, ".gitignore")), false);
        },
        { filePath, noWorkspace: true, input: "fix this", answer: "Add" },
      ),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a folder with no repository keeps the .gitignore route and names the folder", async () => {
  await withProvider(
    async ({ root, provider, editor, prompts }) => {
      await provider.startCommentAtLine(editor.document.uri, 0);
      assert.deepEqual(prompts, [`Add .local-review/ to .gitignore in ${path.basename(root)}?`]);
      assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /^\.local-review\/$/m);
    },
    { input: "x", answer: "Add" },
  );
});

test("a symlinked exclude file is refused and the link target is untouched", async () => {
  await withRealRepo(
    async ({ home, repo, provider, editor, warnings }) => {
      const target = path.join(home, "victim");
      fs.writeFileSync(target, "keep\n");
      fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
      fs.rmSync(path.join(repo, ".git", "info", "exclude"), { force: true });
      fs.symlinkSync(target, path.join(repo, ".git", "info", "exclude"));
      await provider.startCommentAtLine(editor.document.uri, 0);
      assert.equal(fs.readFileSync(target, "utf8"), "keep\n");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /Failed to update the ignore rules/);
    },
    { answer: "Add" },
  );
});

test("a workspace folder inside a repo (no .git entry of its own) uses the repo's private exclude", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "provider-sub-")));
  try {
    const repo = path.join(home, "other", "repo");
    const sub = path.join(repo, "sub");
    fs.mkdirSync(sub, { recursive: true });
    git(repo, "init", "-q");
    fs.writeFileSync(path.join(sub, "a.ts"), "line\n");
    await withHome(home, () =>
      withProvider(
        async ({ provider, editor, prompts, warnings }) => {
          await provider.startCommentAtLine(editor.document.uri, 0);
          assert.deepEqual(prompts, ["Ignore .local-review/ in sub?"]);
          assert.deepEqual(warnings, []);
          assert.match(
            fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8"),
            /^\.local-review\/$/m,
          );
          assert.equal(fs.existsSync(path.join(sub, ".gitignore")), false);
          assert.equal(fs.existsSync(path.join(repo, ".gitignore")), false);
        },
        { root: sub, filePath: path.join(sub, "a.ts"), input: "x", answer: "Add" },
      ),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an already ignored folder inside a repo gets no prompt", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "provider-sub-")));
  try {
    const repo = path.join(home, "other", "repo");
    const sub = path.join(repo, "sub");
    fs.mkdirSync(sub, { recursive: true });
    git(repo, "init", "-q");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".local-review/\n");
    fs.writeFileSync(path.join(sub, "a.ts"), "line\n");
    await withHome(home, () =>
      withProvider(
        async ({ provider, editor, prompts }) => {
          await provider.startCommentAtLine(editor.document.uri, 0);
          assert.deepEqual(prompts, []);
        },
        { root: sub, filePath: path.join(sub, "a.ts"), input: "x", answer: "Add" },
      ),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a missing git gives no prompt and writes nothing", async () => {
  await withRealRepo(
    async ({ repo, provider, editor, prompts, warnings }) => {
      const saved = process.env.PATH;
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "provider-nogit-"));
      process.env.PATH = empty;
      try {
        await provider.startCommentAtLine(editor.document.uri, 0);
      } finally {
        process.env.PATH = saved;
        fs.rmSync(empty, { recursive: true, force: true });
      }
      assert.deepEqual(prompts, []);
      assert.deepEqual(warnings, []);
      assert.equal(fs.existsSync(path.join(repo, ".gitignore")), false);
      assert.doesNotMatch(
        fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8"),
        /local-review/,
      );
    },
    { answer: "Add" },
  );
});

// A cloned repo can ship a `.git` file that redirects git to any directory. The exclude file is
// written only when that directory really is this folder's own git dir.
const plant = async (home, otherName, body) => {
  const evil = path.join(home, "git", "evil");
  const fake = path.join(home, "git", "fake");
  const other = path.join(home, "git", ...otherName);
  fs.mkdirSync(evil, { recursive: true });
  for (const dir of [fake, path.join(other, "objects"), path.join(other, "refs")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(evil, ".git"), "gitdir: ../fake\n");
  fs.writeFileSync(path.join(fake, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(fake, "commondir"), `${path.relative(fake, other)}\n`);
  fs.writeFileSync(path.join(other, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(evil, "a.ts"), "line\n");
  await withHome(home, () =>
    withProvider(body, {
      filePath: path.join(evil, "a.ts"),
      noWorkspace: true,
      input: "x",
      answer: "Add",
    }),
  );
  return { evil, fake, other };
};

for (const otherName of [["other"], ["elsewhere", ".git"]]) {
  test(`a planted .git file redirecting to ${otherName.join("/")} gets no prompt and no write`, async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "provider-plant-")));
    try {
      const seen = [];
      const { other } = await plant(
        home,
        otherName,
        async ({ provider, editor, prompts, warnings }) => {
          await provider.startCommentAtLine(editor.document.uri, 0);
          seen.push(prompts, warnings);
        },
      );
      assert.deepEqual(seen, [[], []]);
      assert.equal(fs.existsSync(path.join(other, "info")), false);
      assert.equal(fs.existsSync(path.join(home, "git", "fake", "info")), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
