const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { withProvider, withHome, until } = require("./provider-harness.cjs");

const OUT = "../../out/features/comment/utils/";

// A fake home with ~/git/repo (a clone) holding src/a.ts; no workspace folder is open.
const withRepo = async (body, options = {}) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "provider-home-")));
  const repo = path.join(home, "git", "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src"));
  const filePath = path.join(repo, "src", "a.ts");
  fs.writeFileSync(filePath, "line\n");
  try {
    await withHome(home, () =>
      withProvider((ctx) => body({ ...ctx, home, repo }), {
        filePath,
        noWorkspace: true,
        ...options,
      }),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
};

test("a ~/git file with no workspace folder saves to <repo>/.local-review/<rel>.review.json", async () => {
  await withRepo(
    async ({ repo, provider, editor, created, warnings }) => {
      await provider.startCommentAtLine(editor.document.uri, 0);
      const file = path.join(repo, ".local-review", "src", "a.ts.review.json");
      assert.ok(fs.existsSync(file));
      assert.deepEqual(warnings, []);
      assert.equal(created.length, 1);
      assert.deepEqual(provider.roots(), [repo]);
    },
    { input: "fix this" },
  );
});

test("a file outside ~/git and every workspace folder is refused with the general message", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "provider-outside-"));
  try {
    await withProvider(
      async ({ provider, editor, warnings }) => {
        await provider.startCommentAtLine(editor.document.uri, 0);
        assert.deepEqual(warnings, [
          "Comments are only saved for files in a git repository under ~/git, or under the open folder.",
        ]);
        assert.deepEqual(provider.roots(), []);
      },
      { filePath: path.join(outside, "a.ts"), noWorkspace: true, input: "x" },
    );
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("an external edit of a review file in a root outside the workspace refreshes the threads", async () => {
  await withRepo(async ({ repo, provider, editor, created }) => {
    const { FileCommentStore } = require(OUT + "file-store");
    provider.refreshForEditor(editor);
    assert.equal(created.length, 0);
    assert.equal(fs.existsSync(path.join(repo, ".local-review")), false);
    // The .local-review directory does not exist yet; an agent creates it and the file.
    const agent = new FileCommentStore(repo);
    agent.addThread("src/a.ts", 1, "line", "agent-made");
    await until(() => created.length === 1);
    assert.equal(created.length, 1);
    const thread = created[0];
    agent.reply("src/a.ts", agent.listForFile("src/a.ts")[0].id, "agent", "second");
    await until(() => thread.comments.length === 2);
    assert.equal(thread.comments.length, 2);
  });
});
