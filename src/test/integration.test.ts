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
    const provider = createCommentProvider(
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
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
    } finally {
      provider.dispose();
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
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (condition: () => boolean, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (!condition() && Date.now() < deadline) {
      await pause(100);
    }
  };
  const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
  let dir = "";
  let source = "";
  let name = "";
  let hadGuide = false;
  let hadReviewDir = false;

  setup(async function () {
    this.timeout(20000);
    const extension = vscode.extensions.getExtension("stefanthorpe.local-review");
    assert.ok(extension);
    await extension.activate();
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
    fs.writeFileSync(source, "alpha\nbravo\ncharlie\n");
    const document = await vscode.workspace.openTextDocument(source);
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(1, 2, 1, 2);
    await pause(500);
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const guide = path.join(root(), ".local-review", "README.md");
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
  });

  test("the shortcut opens a focused box; typing and submitting stores the comment", async function () {
    this.timeout(30000);
    const store = new FileCommentStore(root());
    await vscode.commands.executeCommand("local-review.addComment");
    await pause(1500);
    await vscode.commands.executeCommand("type", { text: "hello inline" });
    await pause(300);
    await vscode.commands.executeCommand("editor.action.submitComment");
    await until(() => store.listForFile(name).length > 0);
    const threads = store.listForFile(name);
    assert.strictEqual(threads.length, 1, "one thread is stored");
    assert.strictEqual(threads[0].line, 2);
    assert.strictEqual(threads[0].comments[0].body, "hello inline");
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.getText() ?? "",
      "alpha\nbravo\ncharlie\n",
    );
    assert.strictEqual(fs.readFileSync(source, "utf8"), "alpha\nbravo\ncharlie\n");
  });

  test("closing an empty box stores nothing", async function () {
    this.timeout(30000);
    const store = new FileCommentStore(root());
    await vscode.commands.executeCommand("local-review.addComment");
    await pause(1500);
    await vscode.commands.executeCommand("workbench.action.hideComment");
    await pause(500);
    await vscode.commands.executeCommand("editor.action.submitComment");
    await pause(1000);
    assert.strictEqual(store.listForFile(name).length, 0);
    assert.strictEqual(fs.readFileSync(source, "utf8"), "alpha\nbravo\ncharlie\n");
  });
});
