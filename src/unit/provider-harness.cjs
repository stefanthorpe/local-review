const assert = require("node:assert/strict");
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
  const editor = { document, selection: { active: { line: 0 } } };
  const folderLookups = [];
  const executed = [];
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
      getWorkspaceFolder: (u) => {
        folderLookups.push(u);
        return options.noWorkspace ? undefined : { uri: { scheme: "file", fsPath: root } };
      },
      asRelativePath: (u) => path.relative(root, u.fsPath),
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
      getConfiguration: () => ({
        get: (key, fallback) =>
          key === "copyOnComment" ? (options.copyOnComment ?? fallback) : fallback,
      }),
    },
    window: {
      visibleTextEditors: [editor],
      activeTextEditor: options.noEditor ? undefined : editor,
      showWarningMessage: (m) => warnings.push(m),
      showErrorMessage: (m) => warnings.push(m),
      showInformationMessage: async (message) => {
        prompts.push(message);
        options.onPrompt?.(message, created);
        return options.answer;
      },
    },
    commands: {
      registerCommand: (name, fn) => {
        commands[name] = fn;
        return disposable();
      },
      // Stands in for VS Code's own handler of the add-comment command: it asks the controller
      // for an empty template thread (no context value) on the cursor line, as the gutter plus does.
      executeCommand: async (name) => {
        executed.push(name);
        if (name === "workbench.action.addComment" && !options.addCommentNoop) {
          const line = editor.selection.active.line;
          const thread = controller.createCommentThread(
            uri,
            new vscode.Range(line, 0, line, 0),
            [],
          );
          thread.canReply = true;
        }
      },
    },
    Range: function (...args) {
      this.args = args;
      this.start = { line: args[0], character: args[1] };
      this.end = { line: args[2], character: args[3] };
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
        collapsibleState: undefined,
        canReply: undefined,
        contextValue: undefined,
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
      async (text) => {
        clipboard.push(text);
        return options.copyOk ?? true;
      },
      controller,
      options.registerCommands ?? true,
    );
    // Types `text` into the newest live template box (an empty thread with no context value), as
    // the user would, and submits it.
    const type = async (text) => {
      const box = created
        .filter((t) => !t.disposed && t.contextValue === undefined && t.comments.length === 0)
        .at(-1);
      assert.ok(box, "no comment box is open");
      await commands["localReview.reply"]({ thread: box, text });
    };
    if (options.input !== undefined) {
      // `input` simulates the user typing that text into the inline box each time one opens.
      const open = provider.startComment;
      provider.startComment = async (...args) => {
        const before = created.filter((t) => !t.disposed).length;
        await open(...args);
        if (created.filter((t) => !t.disposed).length > before) {
          await type(options.input);
        }
      };
    }
    await body({
      root,
      editor,
      provider,
      handlers,
      commands,
      controller,
      type,
      executed,
      folderLookups,
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
