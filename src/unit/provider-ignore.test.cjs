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
