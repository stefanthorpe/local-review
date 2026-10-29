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
  if (homeDepth === 0) {
    // Never let the real $HOME (its ~/git, its git config) reach the code under test.
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "provider-home-")));
    try {
      await withHome(home, () => withProvider(body, options));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
    return;
  }
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "provider-robust-"));
  const uri = {
    scheme: "file",
    fsPath: options.filePath ?? path.join(root, "sub", "a"),
    toString() {
      return this.fsPath;
    },
  };
  const document = { uri, lineCount: 1, lineAt: () => ({ text: "line" }) };
  const editor = { document };
  const disposable = () => ({ dispose() {} });
  const handlers = {};
  const commands = {};
  const warnings = [];
  const clipboard = [];
  const created = [];
  const prompts = [];
  const workspaceFolders = options.noWorkspace
    ? []
    : [{ name: path.basename(root), uri: { scheme: "file", fsPath: root } }];
  const silent = {
    onDidCreate: disposable,
    onDidChange: disposable,
    onDidDelete: disposable,
    dispose() {},
  };
  const vscode = {
    workspace: {
      get workspaceFolders() {
        return workspaceFolders;
      },
      getWorkspaceFolder: () =>
        options.noWorkspace ? undefined : { uri: { scheme: "file", fsPath: root } },
      createFileSystemWatcher: () => silent,
      onDidChangeTextDocument: disposable,
      onDidChangeWorkspaceFolders: (f) => {
        handlers.folders = f;
        return disposable();
      },
      onDidCloseTextDocument: (f) => {
        handlers.close = f;
        return disposable();
      },
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    },
    window: {
      visibleTextEditors: [editor],
      activeTextEditor: options.noEditor ? undefined : editor,
      showWarningMessage: (m) => warnings.push(m),
      showErrorMessage: (m) => warnings.push(m),
      showInformationMessage: async (message) => {
        prompts.push(message);
        return options.answer;
      },
    },
    commands: {
      registerCommand: (name, fn) => {
        commands[name] = fn;
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
        return options.copyOk ?? true;
      },
      controller,
      options.registerCommands ?? false,
    );
    await body({
      root,
      editor,
      provider,
      handlers,
      commands,
      warnings,
      clipboard,
      created,
      prompts,
      workspaceFolders,
      // Runs Copy All against this provider and the same mocked vscode.
      submit: async () => {
        delete require.cache[require.resolve(OUT + "actions")];
        const { submitComments } = require(OUT + "actions");
        await submitComments({
          commentProvider: provider,
          copyToClipboard: async (text) => {
            clipboard.push(text);
            return true;
          },
        });
      },
      store: new FileCommentStore(root),
    });
  } finally {
    provider?.dispose();
    Module._load = load;
    fs.rmSync(root, { recursive: true, force: true });
  }
};

// Points os.homedir() at `home` for the duration of `body` (it reads $HOME on POSIX only, so
// these tests are POSIX-only), and away from the caller's XDG git config.
let homeDepth = 0;
const withHome = async (home, body) => {
  homeDepth++;
  const saved = process.env.HOME;
  const savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".no-xdg-config");
  try {
    await body();
  } finally {
    homeDepth--;
    if (saved === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = saved;
    }
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
  }
};

module.exports = { withProvider, withHome, wait, until };
