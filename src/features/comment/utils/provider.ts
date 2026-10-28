import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { addReviewIgnore, FileCommentStore } from "./file-store";
import { repin } from "./anchor";
import { getEditorFileName } from "../../editor/utils/detector";
import { formatStandardComment } from "./format";
import type { CommentInputResult } from "./input";

export interface CommentProvider {
  startCommentAtLine(uri: vscode.Uri, line: number): Promise<void>;
  refreshForEditor(editor?: vscode.TextEditor): void;
  clearAllThreads(): void;
  dispose(): void;
}

export const createCommentProvider = (
  context: vscode.ExtensionContext,
  showCommentInput: () => Promise<CommentInputResult | undefined>,
  copyToClipboard: (text: string) => Promise<boolean>,
  controller = vscode.comments.createCommentController("localReview", "Local Review"),
  registerCommands = true,
): CommentProvider => {
  const threads = new Map<string, Map<string, vscode.CommentThread>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const snapshots = new Map<string, string>();
  const stores = new Map<string, FileCommentStore>();
  const storeFor = (uri: vscode.Uri) => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (uri.scheme !== "file" || !folder || folder.uri.scheme !== "file") {
      return undefined;
    }
    let store = stores.get(folder.uri.fsPath);
    if (!store) {
      store = new FileCommentStore(folder.uri.fsPath, (message) => {
        void vscode.window.showWarningMessage(message);
      });
      stores.set(folder.uri.fsPath, store);
    }
    const relative = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/");
    return { store, relative, folder };
  };
  const clear = (key: string) => {
    for (const thread of threads.get(key)?.values() ?? []) {
      thread.dispose();
    }
    threads.delete(key);
  };
  const refreshForEditor = (editor?: vscode.TextEditor) => {
    if (!editor) {
      return;
    }
    const uri = editor.document.uri;
    const info = storeFor(uri);
    if (!info) {
      return;
    }
    let exists = true;
    try {
      fs.lstatSync(
        path.join(info.folder.uri.fsPath, ".local-review", `${info.relative}.review.json`),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        exists = false;
      }
    }
    const values = exists ? info.store.listForFile(info.relative) : [];
    const lines = Array.from(
      { length: editor.document.lineCount },
      (_, i) => editor.document.lineAt(i).text,
    );
    const key = uri.toString();
    const snapshot = JSON.stringify([values, lines]);
    if (snapshots.get(key) === snapshot) {
      return;
    }
    snapshots.set(key, snapshot);
    const rendered = threads.get(key) ?? new Map<string, vscode.CommentThread>();
    const remaining = new Set(rendered.keys());
    for (const item of values) {
      const pinned = repin(item.line, item.anchor, lines);
      const line = Math.max(0, Math.min(lines.length - 1, pinned.line - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const comments = item.comments.map((c) => ({
        body: new vscode.MarkdownString(c.body),
        mode: vscode.CommentMode.Preview,
        author: { name: c.author },
      }));
      let thread = rendered.get(item.id);
      if (!thread) {
        thread = controller.createCommentThread(uri, range, comments);
        rendered.set(item.id, thread);
        thread.canReply = true;
        thread.collapsibleState =
          item.status === "resolved"
            ? vscode.CommentThreadCollapsibleState.Collapsed
            : vscode.CommentThreadCollapsibleState.Expanded;
      } else {
        thread.range = range;
        thread.comments = comments;
      }
      remaining.delete(item.id);
      thread.label = pinned.outdated ? "Local Review (outdated)" : "Local Review";
      thread.contextValue = `localReviewThread:${item.status}:${item.id}`;
      thread.state =
        item.status === "resolved"
          ? vscode.CommentThreadState.Resolved
          : vscode.CommentThreadState.Unresolved;
    }
    for (const id of remaining) {
      rendered.get(id)?.dispose();
      rendered.delete(id);
    }
    threads.set(key, rendered);
  };
  const operate = (
    thread: vscode.CommentThread,
    fn: (store: FileCommentStore, file: string, id: string) => void,
  ) => {
    const uri = thread.uri;
    const info = storeFor(uri);
    const id = thread.contextValue?.replace(/^localReviewThread:(?:open|resolved):/, "");
    if (id === thread.contextValue) {
      return;
    }
    if (!info || !id) {
      return;
    }
    try {
      fn(info.store, info.relative, id);
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.toString() === thread.uri.toString()) {
          refreshForEditor(editor);
        }
      }
    } catch (error) {
      void vscode.window.showWarningMessage(String(error));
    }
  };
  if (registerCommands) {
    context.subscriptions.push(
      vscode.commands.registerCommand("localReview.deleteComment", (thread: vscode.CommentThread) =>
        operate(thread, (s, f, id) => s.deleteThread(f, id)),
      ),
      vscode.commands.registerCommand("localReview.resolve", (thread: vscode.CommentThread) =>
        operate(thread, (s, f, id) => s.resolve(f, id)),
      ),
      vscode.commands.registerCommand("localReview.reopen", (thread: vscode.CommentThread) =>
        operate(thread, (s, f, id) => s.reopen(f, id)),
      ),
      vscode.commands.registerCommand("localReview.reply", (reply: vscode.CommentReply) =>
        operate(reply.thread, (s, f, id) => s.reply(f, id, "user", reply.text)),
      ),
    );
  }
  const watcher = vscode.workspace.createFileSystemWatcher("**/.local-review/**/*.review.json");
  const folderWatcher = vscode.workspace.createFileSystemWatcher("**/.local-review");
  const onChange = () => {
    for (const editor of vscode.window.visibleTextEditors) {
      refreshForEditor(editor);
    }
  };
  context.subscriptions.push(
    watcher,
    folderWatcher,
    folderWatcher.onDidDelete(onChange),
    watcher.onDidCreate(onChange),
    watcher.onDidChange(onChange),
    watcher.onDidDelete(onChange),
    vscode.workspace.onDidChangeTextDocument((e) => {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === e.document) {
          const key = editor.document.uri.toString();
          clearTimeout(timers.get(key));
          timers.set(
            key,
            setTimeout(() => {
              timers.delete(key);
              refreshForEditor(editor);
            }, 150),
          );
        }
      }
    }),
  );
  const startCommentAtLine = async (uri: vscode.Uri, line: number) => {
    const editor = vscode.window.activeTextEditor;
    const info = storeFor(uri);
    if (!info || !editor) {
      void vscode.window.showWarningMessage("No workspace folder found");
      return;
    }
    const result = await showCommentInput();
    if (!result) {
      return;
    }
    const dir = path.join(info.folder.uri.fsPath, ".local-review");
    const first = !fs.existsSync(path.join(dir, "README.md"));
    info.store.addThread(info.relative, line + 1, editor.document.lineAt(line).text, result.text);
    if (first) {
      try {
        const answer = await vscode.window.showInformationMessage(
          "Add .local-review/ to .gitignore?",
          "Add",
        );
        if (answer === "Add") {
          addReviewIgnore(info.folder.uri.fsPath);
        }
      } catch (error) {
        void vscode.window.showWarningMessage(`Failed to update .gitignore: ${error}`);
      }
    }
    refreshForEditor(editor);
    if (vscode.workspace.getConfiguration("localReview").get<boolean>("copyOnComment", false)) {
      await copyToClipboard(
        formatStandardComment({
          fileName: getEditorFileName(editor),
          lineNumber: line,
          text: result.text,
        }),
      );
    }
  };
  const clearAllThreads = () => {
    for (const key of threads.keys()) {
      clear(key);
    }
    snapshots.clear();
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  };
  return {
    startCommentAtLine,
    refreshForEditor,
    clearAllThreads,
    dispose: () => {
      clearAllThreads();
      controller.dispose();
    },
  };
};
