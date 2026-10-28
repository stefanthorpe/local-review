const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

test("provider preserves threads, deduplicates warnings, handles colon ids and folder deletion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-"));
  const handlers = {};
  const commands = {};
  const watchers = {};
  const warnings = [];
  const created = [];
  const uri = {
    scheme: "file",
    fsPath: path.join(root, "a"),
    toString() {
      return this.fsPath;
    },
  };
  const document = { uri, lineCount: 1, lineAt: () => ({ text: "line" }) };
  const editor = { document };
  const disposable = () => ({ dispose() {} });
  const vscode = {
    workspace: {
      getWorkspaceFolder: () => ({ uri: { scheme: "file", fsPath: root } }),
      createFileSystemWatcher: (pattern) => {
        const watcher = {
          onDidCreate: (f) => {
            watcher.create = f;
            return disposable();
          },
          onDidChange: (f) => {
            watcher.change = f;
            return disposable();
          },
          onDidDelete: (f) => {
            watcher.delete = f;
            return disposable();
          },
          dispose() {},
        };
        watchers[pattern] = watcher;
        return watcher;
      },
      onDidChangeTextDocument: (f) => {
        handlers.edit = f;
        return disposable();
      },
    },
    window: {
      visibleTextEditors: [editor],
      activeTextEditor: editor,
      showWarningMessage: (m) => warnings.push(m),
    },
    commands: {
      registerCommand: (name, f) => {
        commands[name] = f;
        return disposable();
      },
    },
    Range: function (...args) {
      this.args = args;
    },
    MarkdownString: function (value) {
      this.value = value;
    },
    CommentMode: { Preview: 0 },
    CommentThreadState: { Resolved: 1, Unresolved: 0 },
    CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
  };
  const controller = {
    createCommentThread(uri, range, comments) {
      const t = {
        uri,
        range,
        comments,
        disposed: 0,
        dispose() {
          this.disposed++;
        },
      };
      created.push(t);
      return t;
    },
    dispose() {},
  };
  const load = Module._load;
  Module._load = function (request, ...args) {
    return request === "vscode" ? vscode : load.call(this, request, ...args);
  };
  try {
    const { createCommentProvider } = require("../../out/features/comment/utils/provider");
    const { FileCommentStore } = require("../../out/features/comment/utils/file-store");
    const store = new FileCommentStore(root);
    store.addThread("a", 1, "line", "body");
    const review = store.reviewPath("a");
    const data = JSON.parse(fs.readFileSync(review));
    data.threads[0].id = "t:fix:1";
    fs.writeFileSync(review, JSON.stringify(data));
    const subscriptions = [];
    const provider = createCommentProvider(
      { subscriptions },
      async () => undefined,
      async () => true,
      controller,
    );
    provider.refreshForEditor(editor);
    const thread = created[0];
    const diff = { ...document, uri: { ...uri, scheme: "git" } };
    provider.refreshForEditor({ document: diff });
    await provider.startCommentAtLine(diff.uri, 0);
    assert.equal(created.length, 1);
    warnings.length = 0;
    document.lineAt = () => ({ text: "changed" });
    handlers.edit({ document });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(created.length, 1);
    assert.equal(thread.disposed, 0);
    commands["localReview.resolve"](thread);
    assert.equal(store.listForFile("a")[0].status, "resolved");
    fs.writeFileSync(review, "{broken");
    for (let i = 0; i < 3; i++) {
      handlers.edit({ document });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(warnings.length, 1);
    fs.writeFileSync(review, JSON.stringify(data));
    provider.refreshForEditor(editor);
    fs.rmSync(path.join(root, ".local-review"), { recursive: true });
    watchers["**/.local-review"].delete();
    assert.equal(created.at(-1).disposed, 1);
    provider.dispose();
    subscriptions.forEach((s) => s.dispose());
  } finally {
    Module._load = load;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
