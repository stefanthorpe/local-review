const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { withProvider, withHome } = require("./provider-harness.cjs");

const withHomeDir = async (body) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "provider-state-")));
  try {
    await withHome(home, () => body(home));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
};

test("only an untitled document is told to save first", async () => {
  await withProvider(
    async ({ provider, editor, warnings }) => {
      await provider.startCommentAtLine({ ...editor.document.uri, scheme: "untitled" }, 0);
      assert.deepEqual(warnings, ["Save the file first; comments are stored next to saved files."]);
    },
    { input: "x" },
  );
});

test("no active editor asks to open the file in an editor", async () => {
  await withProvider(
    async ({ provider, editor, warnings }) => {
      await provider.startCommentAtLine(editor.document.uri, 0);
      assert.deepEqual(warnings, ["Open the file in an editor to comment on it."]);
    },
    { input: "x", noEditor: true },
  );
});

test("a non-file, non-untitled scheme says comments are for files on this machine", async () => {
  await withProvider(
    async ({ provider, editor, warnings }) => {
      await provider.startCommentAtLine({ ...editor.document.uri, scheme: "vscode-remote" }, 0);
      assert.deepEqual(warnings, ["Comments can only be saved for files on this machine."]);
    },
    { input: "x" },
  );
});

test("a ~/git file in no repository and outside the workspace gets the repository message", async () => {
  await withHomeDir(async (home) => {
    const file = path.join(home, "git", "loose", "a.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x\n");
    await withProvider(
      async ({ provider, editor, warnings }) => {
        await provider.startCommentAtLine(editor.document.uri, 0);
        assert.deepEqual(warnings, [
          "Comments are saved in the git repository that holds the file; this file under ~/git is not in one.",
        ]);
      },
      { filePath: file, noWorkspace: true, input: "x" },
    );
  });
});

test("removing a workspace folder drops its fallback root but keeps repo roots", async () => {
  await withProvider(
    async ({ root, provider, editor, handlers }) => {
      await provider.startCommentAtLine(editor.document.uri, 0);
      assert.deepEqual(provider.roots(), [root]);
      handlers.folders({ removed: [{ uri: { scheme: "file", fsPath: root } }] });
      assert.deepEqual(provider.roots(), []);
    },
    { input: "x" },
  );
  await withProvider(
    async ({ root, provider, editor, handlers }) => {
      fs.mkdirSync(path.join(root, ".git"));
      await provider.startCommentAtLine(editor.document.uri, 0);
      handlers.folders({ removed: [{ uri: { scheme: "file", fsPath: root } }] });
      assert.deepEqual(provider.roots(), [root]);
    },
    { input: "x" },
  );
});

test("Copy All no longer lists a closed folder's fallback root", async () => {
  await withProvider(
    async ({ root, provider, editor, handlers, workspaceFolders, submit, clipboard, warnings }) => {
      await provider.startCommentAtLine(editor.document.uri, 0);
      await submit();
      assert.equal(clipboard.length, 1);
      assert.match(clipboard[0], /x/);
      workspaceFolders.length = 0;
      handlers.folders({ removed: [{ uri: { scheme: "file", fsPath: root } }] });
      await submit();
      assert.equal(clipboard.length, 1);
      assert.equal(
        warnings.at(-1),
        "Comments are only saved for files under ~/git or the open folder.",
      );
    },
    { input: "x" },
  );
});
