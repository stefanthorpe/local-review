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
        globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => {} },
      } as unknown as vscode.ExtensionContext,
      async () => ({ text: "self" }),
      async () => true,
      controller,
      false,
    );
    // Seed the directory so the first-use prompt does not block this test.
    fs.mkdirSync(reviewDir, { recursive: true });
    if (madeGuide) {
      fs.writeFileSync(guide, "test guide", { flag: "wx" });
    }
    await provider.startCommentAtLine(document.uri, 0);
    if (stopped) {
      return;
    }
    assert.strictEqual(renders, 1);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (stopped) {
      return;
    }
    assert.strictEqual(renders, 1);
    const item = store.listForFile(name)[0];
    store.reply(name, item.id, "agent", "external reply");
    const deadline = Date.now() + 5000;
    while ((rendered?.comments.length ?? 0) < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (stopped) {
        return;
      }
    }
    assert.strictEqual(renders, 1);
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
    assert.strictEqual(disposals, 0);
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
