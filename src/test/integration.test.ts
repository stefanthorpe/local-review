import * as assert from "assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { createCommentProvider } from "../features/comment/utils/provider";
import { FileCommentStore } from "../features/comment/utils/file-store";

suite("Review watcher", () => {
  test("external writes render and self writes do not double-render", async () => {
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const name = `watcher-test-${Date.now()}.txt`;
    const source = path.join(root, name);
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
    try {
      fs.writeFileSync(source, "line\n");
      const document = await vscode.workspace.openTextDocument(source);
      await vscode.window.showTextDocument(document);
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
      assert.strictEqual(renders, 1);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.strictEqual(renders, 1);
      const item = store.listForFile(name)[0];
      store.reply(name, item.id, "agent", "external reply");
      const deadline = Date.now() + 5000;
      while (renders < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.strictEqual(renders, 2);
      assert.strictEqual(renderedComments.length, 2);
      assert.strictEqual(
        (renderedComments[1].body as vscode.MarkdownString).value,
        "external reply",
      );
    } finally {
      provider?.dispose();
      for (const disposable of subscriptions) {
        disposable.dispose();
      }
      fs.rmSync(store.reviewPath(name), { force: true });
      fs.rmSync(source, { force: true });
      if (madeGuide) {
        fs.rmSync(guide, { force: true });
      }
      if (madeDir) {
        fs.rmdirSync(reviewDir);
      }
    }
  });
});
