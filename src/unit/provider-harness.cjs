const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const OUT = "../../out/features/comment/utils/";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) {
    await wait(25);
  }
};

// Runs `body` against a provider wired to a mocked `vscode` whose own file watchers stay silent,
// so only the provider's fs.watch fallback can notice external writes.
const withProvider = async (body, options = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-robust-"));
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
  const handlers = {};
  const warnings = [];
  const clipboard = [];
  const created = [];
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
      onDidCloseTextDocument: (f) => {
        handlers.close = f;
        return disposable();
      },
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    },
    window: {
      visibleTextEditors: [editor],
      activeTextEditor: editor,
      showWarningMessage: (m) => warnings.push(m),
      showInformationMessage: async () => undefined,
    },
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
  const controller = {
    createCommentThread(threadUri, range, comments) {
      const t = {
        uri: threadUri,
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
  let provider;
  try {
    // The module binds `vscode` at load time, so drop any copy bound to another test's mock.
    delete require.cache[require.resolve(OUT + "provider")];
    const { createCommentProvider } = require(OUT + "provider");
    const { FileCommentStore } = require(OUT + "file-store");
    provider = createCommentProvider(
      { subscriptions: [] },
      async () => (options.input ? { text: options.input } : undefined),
      async (text) => {
        clipboard.push(text);
        return true;
      },
      controller,
      false,
    );
    await body({
      root,
      editor,
      provider,
      handlers,
      warnings,
      clipboard,
      created,
      store: new FileCommentStore(root),
    });
  } finally {
    provider?.dispose();
    Module._load = load;
    fs.rmSync(root, { recursive: true, force: true });
  }
};

module.exports = { withProvider, wait, until };
