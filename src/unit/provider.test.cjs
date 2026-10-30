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
      onDidCloseTextDocument: disposable,
      onDidChangeWorkspaceFolders: disposable,
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
    const provider = createCommentProvider({ subscriptions }, async () => true, controller);
    provider.refreshForEditor(editor);
    const thread = created[0];
    const diff = { ...document, uri: { ...uri, scheme: "git" } };
    provider.refreshForEditor({ document: diff });
    await provider.startComment(diff.uri);
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

test("provider re-renders an external write even when the VS Code watcher stays silent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-silent-"));
  const uri = {
    scheme: "file",
    fsPath: path.join(root, "sub", "a"),
    toString() {
      return this.fsPath;
    },
  };
  const document = { uri, lineCount: 1, lineAt: () => ({ text: "line" }) };
  const editor = { document };
  const disposable = () => ({ dispose() {} });
  const silent = {
    onDidCreate: disposable,
    onDidChange: disposable,
    onDidDelete: disposable,
    dispose() {},
  };
  const vscode = {
    workspace: {
      getWorkspaceFolder: () => ({ uri: { scheme: "file", fsPath: root } }),
      createFileSystemWatcher: () => silent,
      onDidChangeTextDocument: disposable,
      onDidCloseTextDocument: disposable,
      onDidChangeWorkspaceFolders: disposable,
    },
    window: { visibleTextEditors: [editor], activeTextEditor: editor, showWarningMessage() {} },
    commands: { registerCommand: disposable },
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
  let thread;
  const controller = {
    createCommentThread(threadUri, range, comments) {
      thread = { uri: threadUri, range, comments, dispose() {} };
      return thread;
    },
    dispose() {},
  };
  const load = Module._load;
  Module._load = function (request, ...args) {
    return request === "vscode" ? vscode : load.call(this, request, ...args);
  };
  let provider;
  try {
    // The module binds `vscode` at load time, so drop the copy bound to the previous test's mock.
    delete require.cache[require.resolve("../../out/features/comment/utils/provider")];
    const { createCommentProvider } = require("../../out/features/comment/utils/provider");
    const { FileCommentStore } = require("../../out/features/comment/utils/file-store");
    const store = new FileCommentStore(root);
    store.addThread("sub/a", 1, "line", "body");
    provider = createCommentProvider({ subscriptions: [] }, async () => true, controller, false);
    provider.refreshForEditor(editor);
    assert.equal(thread.comments.length, 1);
    store.reply("sub/a", store.listForFile("sub/a")[0].id, "agent", "external reply");
    const deadline = Date.now() + 3000;
    while (thread.comments.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(thread.comments.length, 2);
  } finally {
    provider?.dispose();
    Module._load = load;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
