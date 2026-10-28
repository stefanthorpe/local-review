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
    let renderedComments: readonly vscode.Comment[] = [];
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
        renderedComments = comments;
        return { uri, range, comments, dispose() {} } as unknown as vscode.CommentThread;
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
      { subscriptions } as vscode.ExtensionContext,
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
    while (renders < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (stopped) {
        return;
      }
    }
    assert.strictEqual(renders, 2);
    assert.strictEqual(renderedComments.length, 2);
    assert.strictEqual((renderedComments[1].body as vscode.MarkdownString).value, "external reply");
  });
});
