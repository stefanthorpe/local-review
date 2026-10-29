const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { withProvider, withHome } = require("./provider-harness.cjs");

const KEY = "localReview.knownRoots";

const withHomeDir = async (body) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "provider-state-")));
  try {
    await withHome(home, () => body(home));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
};

test("a saved comment persists its root; mere viewing does not", async () => {
  await withProvider(
    async ({ root, provider, editor, state }) => {
      provider.refreshForEditor(editor);
      assert.equal(state.get(KEY), undefined);
      await provider.startCommentAtLine(editor.document.uri, 0);
      assert.deepEqual(state.get(KEY), [root]);
      await provider.startCommentAtLine(editor.document.uri, 0);
      assert.deepEqual(state.get(KEY), [root]);
    },
    { input: "x" },
  );
});

test("persistedRoots drops a root whose .local-review is gone and prunes it from state", async () => {
  await withProvider(
    async ({ root, provider, editor, state }) => {
      await provider.startCommentAtLine(editor.document.uri, 0);
      state.set(KEY, [root, "/nonexistent/gone"]);
      assert.deepEqual(provider.persistedRoots(), [root]);
      assert.deepEqual(state.get(KEY), [root]);
      fs.rmSync(path.join(root, ".local-review"), { recursive: true });
      assert.deepEqual(provider.persistedRoots(), []);
      assert.deepEqual(state.get(KEY), []);
    },
    { input: "x" },
  );
});

test("persistedRoots tolerates a malformed state value", async () => {
  await withProvider(async ({ provider, state }) => {
    state.set(KEY, { not: "an array" });
    assert.deepEqual(provider.persistedRoots(), []);
    state.set(KEY, [42, null]);
    assert.deepEqual(provider.persistedRoots(), []);
  });
});

test("an unsaved or non-file document is told to save first", async () => {
  await withProvider(
    async ({ provider, editor, warnings }) => {
      await provider.startCommentAtLine({ ...editor.document.uri, scheme: "untitled" }, 0);
      assert.deepEqual(warnings, ["Save the file first; comments are stored next to saved files."]);
    },
    { input: "x" },
  );
  await withProvider(
    async ({ provider, editor, warnings }) => {
      await provider.startCommentAtLine(editor.document.uri, 0);
      assert.deepEqual(warnings, ["Save the file first; comments are stored next to saved files."]);
    },
    { input: "x", noEditor: true },
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
