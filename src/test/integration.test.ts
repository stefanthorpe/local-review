import * as assert from "assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { createCommentProvider } from "../features/comment/utils/provider";
import { FileCommentStore } from "../features/comment/utils/file-store";

suite("Review watcher", () => {
  let cleanup: (() => void) | undefined;
  let stopped = false;

  teardown(() => {
    stopped = true;
    cleanup?.();
    cleanup = undefined;
  });

  test("external writes render and self writes do not double-render", async function () {
    this.timeout(15000);
    stopped = false;
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const sourceDir = fs.mkdtempSync(path.join(root, "watcher-test-"));
    const name = `${path.basename(sourceDir)}/source.txt`;
    const source = path.join(sourceDir, "source.txt");
    const store = new FileCommentStore(root);
    const subscriptions: vscode.Disposable[] = [];
    let renders = 0;
    let rendered: vscode.CommentThread | undefined;
    let disposals = 0;
    const reviewDir = path.join(root, ".local-review");
    const guide = path.join(reviewDir, "README.md");
    const madeDir = !fs.existsSync(reviewDir);
    const madeGuide = !fs.existsSync(guide);
    const controller = {
      createCommentThread(
        uri: vscode.Uri,
        range: vscode.Range,
        comments: readonly vscode.Comment[],
      ) {
        renders++;
        rendered = {
          uri,
          range,
          comments,
          dispose() {
            disposals++;
          },
        } as unknown as vscode.CommentThread;
        return rendered;
      },
      dispose() {},
    } as unknown as vscode.CommentController;
    let provider: ReturnType<typeof createCommentProvider> | undefined;
    cleanup = () => {
      provider?.dispose();
      for (const disposable of subscriptions) {
        disposable.dispose();
      }
      fs.rmSync(path.join(reviewDir, path.basename(sourceDir)), { recursive: true, force: true });
      fs.rmSync(sourceDir, { recursive: true, force: true });
      if (madeGuide) {
        fs.rmSync(guide, { force: true });
      }
      if (madeDir && fs.existsSync(reviewDir)) {
        fs.rmdirSync(reviewDir);
      }
    };
    fs.writeFileSync(source, "line\n");
    const document = await vscode.workspace.openTextDocument(source);
    if (stopped) {
      return;
    }
    await vscode.window.showTextDocument(document);
    if (stopped) {
      return;
    }
    provider = createCommentProvider(
      {
        subscriptions,
      } as unknown as vscode.ExtensionContext,
      async () => true,
      controller,
      false,
    );
    // Seed the directory so the first-use prompt does not block this test.
    fs.mkdirSync(reviewDir, { recursive: true });
    if (madeGuide) {
      fs.writeFileSync(guide, "test guide", { flag: "wx" });
    }
    // The empty box VS Code opens for a new comment (as for the gutter plus) is a template
    // thread: no context value, and writing nothing until a comment is submitted.
    const draft = controller.createCommentThread(document.uri, new vscode.Range(0, 0, 0, 0), []);
    assert.strictEqual(renders, 1);
    assert.strictEqual(draft.comments.length, 0);
    assert.strictEqual(store.listForFile(name).length, 0);
    await provider.submitReply({ thread: draft, text: "self" });
    if (stopped) {
      return;
    }
    // Submitting stores the thread, replaces the box and renders the stored thread once.
    assert.strictEqual(store.listForFile(name).length, 1);
    assert.strictEqual(disposals, 1);
    assert.strictEqual(renders, 2);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (stopped) {
      return;
    }
    assert.strictEqual(renders, 2);
    const item = store.listForFile(name)[0];
    store.reply(name, item.id, "agent", "external reply");
    const deadline = Date.now() + 5000;
    while ((rendered?.comments.length ?? 0) < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (stopped) {
        return;
      }
    }
    assert.strictEqual(renders, 2);
    assert.ok(rendered);
    assert.strictEqual(rendered.comments.length, 2);
    assert.strictEqual(
      (rendered.comments[1].body as vscode.MarkdownString).value,
      "external reply",
    );
    const original = rendered;
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), "new line\n");
    await vscode.workspace.applyEdit(edit);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.strictEqual(rendered, original);
    assert.strictEqual(disposals, 1);
  });
});

suite("Gutter comment ranges", () => {
  test("a saved workspace file gets the whole document; an untitled one gets none", async function () {
    this.timeout(15000);
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const dir = fs.mkdtempSync(path.join(root, "gutter-test-"));
    const source = path.join(dir, "source.txt");
    const controller = {
      dispose() {},
    } as unknown as vscode.CommentController;
    const subscriptions: vscode.Disposable[] = [];
    const provider = createCommentProvider(
      { subscriptions } as unknown as vscode.ExtensionContext,
      async () => true,
      controller,
      false,
    );
    try {
      fs.writeFileSync(source, "one\ntwo\nthree\n");
      const saved = await vscode.workspace.openTextDocument(source);
      const token = new vscode.CancellationTokenSource().token;
      const ranges = controller.commentingRangeProvider!.provideCommentingRanges(saved, token);
      assert.deepStrictEqual(ranges, [new vscode.Range(0, 0, saved.lineCount - 1, 0)]);
      const untitled = await vscode.workspace.openTextDocument({ content: "x\n" });
      assert.strictEqual(
        controller.commentingRangeProvider!.provideCommentingRanges(untitled, token),
        undefined,
      );
      await vscode.window.showTextDocument(untitled);
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    } finally {
      // The provider's own watchers and listeners must not outlive the test: a late event would
      // call into this stand-in controller while a later test runs.
      provider.dispose();
      for (const disposable of subscriptions) {
        disposable.dispose();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

suite("Real comment controller commands", () => {
  test("resolve and delete use the thread context value", async function () {
    this.timeout(15000);
    const extension = vscode.extensions.getExtension("stefanthorpe.local-review");
    assert.ok(extension);
    await extension.activate();
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const dir = fs.mkdtempSync(path.join(root, "real-controller-"));
    const name = `${path.basename(dir)}/source.txt`;
    const source = path.join(dir, "source.txt");
    const store = new FileCommentStore(root);
    const guide = path.join(root, ".local-review", "README.md");
    const hadGuide = fs.existsSync(guide);
    const hadReviewDir = fs.existsSync(path.dirname(guide));
    const controller = vscode.comments.createCommentController("localReviewTest", "Test");
    try {
      fs.writeFileSync(source, "line\n");
      const item = store.addThread(name, 1, "line", "body");
      const document = await vscode.workspace.openTextDocument(source);
      await vscode.window.showTextDocument(document);
      const thread = controller.createCommentThread(document.uri, new vscode.Range(0, 0, 0, 0), []);
      thread.contextValue = `localReviewThread:open:${item.id}`;
      await vscode.commands.executeCommand("localReview.resolve", thread);
      assert.strictEqual(store.listForFile(name)[0].status, "resolved");
      thread.contextValue = `localReviewThread:resolved:${item.id}`;
      await vscode.commands.executeCommand("localReview.deleteComment", thread);
      assert.strictEqual(store.listForFile(name).length, 0);
      thread.dispose();
    } finally {
      controller.dispose();
      fs.rmSync(path.join(root, ".local-review", path.basename(dir)), {
        recursive: true,
        force: true,
      });
      fs.rmSync(dir, { recursive: true, force: true });
      if (!hadGuide) {
        fs.rmSync(guide, { force: true });
      }
      if (!hadReviewDir) {
        fs.rmdirSync(path.dirname(guide));
      }
    }
  });
});

suite("Real inline comment box", () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // Polls an observable condition and fails loudly, naming what never happened.
  const waitFor = async (
    what: string,
    condition: () => boolean | Promise<boolean>,
    ms = 10000,
  ): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!(await condition())) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await wait(50);
    }
  };
  const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
  let dir = "";
  let source = "";
  let name = "";
  let hadGuide = false;
  let hadReviewDir = false;
  let document: vscode.TextDocument;
  let store: FileCommentStore;
  const ORIGINAL = "alpha\nbravo\ncharlie\n";

  // Keystrokes go to whatever has focus, and the box takes it a moment after the command that
  // opens it. A keystroke that reaches the source editor edits the document, which is observable,
  // so an attempt whose text edited the document is undone and retried, backing off a little more
  // each time; the text has reached the box only when the document did not change. `reset` closes
  // a box from a failed attempt first, because opening again over one would toggle it shut.
  const typeIntoBox = async (
    open: () => Thenable<unknown>,
    text: string,
    reset?: () => Thenable<unknown>,
  ) => {
    let attempt = 0;
    await waitFor("the text to reach the comment box", async () => {
      if (attempt > 0) {
        await reset?.();
      }
      await open();
      await wait(Math.min(100 * ++attempt, 500));
      const version = document.version;
      await vscode.commands.executeCommand("type", { text });
      if (document.version === version) {
        return true;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), ORIGINAL);
      await vscode.workspace.applyEdit(edit);
      return false;
    });
  };
  const hideBox = () => vscode.commands.executeCommand("workbench.action.hideComment");
  const shortcut = () => vscode.commands.executeCommand("local-review.addComment");
  const submitBox = () => vscode.commands.executeCommand("editor.action.submitComment");
  const bodies = () => store.listForFile(name).flatMap((t) => t.comments.map((c) => c.body));

  setup(async function () {
    this.timeout(20000);
    const extension = vscode.extensions.getExtension("stefanthorpe.local-review");
    assert.ok(extension);
    await extension.activate();
    store = new FileCommentStore(root());
    dir = fs.mkdtempSync(path.join(root(), "real-box-"));
    name = `${path.basename(dir)}/source.txt`;
    source = path.join(dir, "source.txt");
    const guide = path.join(root(), ".local-review", "README.md");
    hadGuide = fs.existsSync(guide);
    hadReviewDir = fs.existsSync(path.dirname(guide));
    // Seed the directory so the first-use ignore prompt does not wait on nobody.
    fs.mkdirSync(path.dirname(guide), { recursive: true });
    if (!hadGuide) {
      fs.writeFileSync(guide, "test guide", { flag: "wx" });
    }
    fs.writeFileSync(source, ORIGINAL);
    document = await vscode.workspace.openTextDocument(source);
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(1, 2, 1, 2);
  });

  teardown(async () => {
    const guide = path.join(root(), ".local-review", "README.md");
    try {
      fs.rmSync(path.join(root(), ".local-review", path.basename(dir)), {
        recursive: true,
        force: true,
      });
      fs.rmSync(dir, { recursive: true, force: true });
      if (!hadGuide) {
        fs.rmSync(guide, { force: true });
      }
      if (!hadReviewDir && fs.existsSync(path.dirname(guide))) {
        fs.rmdirSync(path.dirname(guide));
      }
    } finally {
      // A dirty editor would make closing ask to save; revert those first.
      for (const dirty of vscode.workspace.textDocuments.filter((d) => d.isDirty)) {
        await vscode.window.showTextDocument(dirty);
        await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
      }
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }
  });

  const assertSourceUntouched = () => {
    assert.strictEqual(document.getText(), ORIGINAL);
    assert.strictEqual(fs.readFileSync(source, "utf8"), ORIGINAL);
  };

  test("the shortcut opens a focused box; typing and submitting stores the comment", async function () {
    this.timeout(30000);
    await typeIntoBox(shortcut, "hello inline", hideBox);
    await submitBox();
    await waitFor("the comment to be stored", () => store.listForFile(name).length > 0);
    const threads = store.listForFile(name);
    assert.strictEqual(threads.length, 1, "one thread is stored");
    assert.strictEqual(threads[0].line, 2);
    assert.strictEqual(threads[0].comments[0].body, "hello inline");
    assertSourceUntouched();
  });

  test("after submitting, typing goes to the source editor", async function () {
    this.timeout(30000);
    await typeIntoBox(shortcut, "focus check", hideBox);
    await submitBox();
    await waitFor("the comment to be stored", () => store.listForFile(name).length > 0);
    const version = document.version;
    await vscode.commands.executeCommand("type", { text: "Z" });
    assert.notStrictEqual(
      document.version,
      version,
      "the keystroke after submit reached the editor",
    );
    assert.strictEqual(document.getText(), "alpha\nbrZavo\ncharlie\n");
  });

  // VS Code's own add-comment command hides a thread that is already open on the line; the
  // extension opens it instead (workbench.action.focusCommentOnCurrentLine, which focuses the
  // thread widget but not its reply box, so no typing is asserted here). The control: the
  // shortcut on that line made no second box and no edit, and a box on another line still works.
  test("the shortcut on a line that already has a comment adds no second thread", async function () {
    this.timeout(30000);
    await typeIntoBox(shortcut, "first", hideBox);
    await submitBox();
    await waitFor("the first comment to be stored", () => store.listForFile(name).length > 0);
    await shortcut();
    // Moving the cursor with the focus (the shortcut left it in the thread) in one step.
    await vscode.window.showTextDocument(document, {
      selection: new vscode.Range(2, 1, 2, 1),
      preserveFocus: false,
    });
    await typeIntoBox(shortcut, "other line", hideBox);
    await submitBox();
    await waitFor("the other-line comment to be stored", () => store.listForFile(name).length > 1);
    const threads = store.listForFile(name);
    assert.deepStrictEqual(
      threads.map((t) => [t.line, t.comments.map((c) => c.body)]),
      [
        [2, ["first"]],
        [3, ["other line"]],
      ],
    );
    assertSourceUntouched();
  });

  // Hiding a box keeps what was typed: VS Code holds the draft for that line and the shortcut
  // brings the same box back with it, so nothing is lost and nothing is stored until submit.
  test("hiding a box stores nothing, and the shortcut brings the box back with its draft", async function () {
    this.timeout(30000);
    await typeIntoBox(shortcut, "draft", hideBox);
    await hideBox();
    await wait(300);
    assert.strictEqual(store.listForFile(name).length, 0, "hiding stored nothing");
    await typeIntoBox(shortcut, " more", hideBox);
    await submitBox();
    await waitFor("the comment to be stored", () => store.listForFile(name).length > 0);
    assert.deepStrictEqual(bodies(), ["draft more"]);
    assert.strictEqual(store.listForFile(name).length, 1);
    assertSourceUntouched();
  });
});
