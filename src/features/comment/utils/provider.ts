import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { FileCommentStore } from "./file-store";
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

const guide = `# Local Review files\n\nEach *.review.json file mirrors a workspace source file. It contains version 1, a workspace-relative POSIX file path, and threads with id, 1-based line, trimmed anchor, status (open or resolved), and comments. Comments have id, author, Markdown body, and ISO UTC at. Preserve existing fields.\n\nTo reply, append a comment with a unique id, your author name, body and timestamp. To resolve or reopen, set status to resolved or open. To delete, remove the thread from threads.\n`;

export const createCommentProvider = (
  context: vscode.ExtensionContext,
  showCommentInput: () => Promise<CommentInputResult | undefined>,
  copyToClipboard: (text: string) => Promise<boolean>,
  controller = vscode.comments.createCommentController("localReview", "Local Review"),
  registerCommands = true,
): CommentProvider => {
  const threads = new Map<string, vscode.CommentThread[]>();
  const snapshots = new Map<string, string>();
  const stores = new Map<string, FileCommentStore>();
  const storeFor = (uri: vscode.Uri) => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || folder.uri.scheme !== "file") {
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
    for (const thread of threads.get(key) ?? []) {
      thread.dispose();
    }
    threads.delete(key);
  };
  const refreshForEditor = (editor?: vscode.TextEditor) => {
    if (!editor) {
      return;
    }
    const uri = editor.document.uri;
    const info = storeFor(uri.scheme === "file" ? uri : vscode.Uri.file(uri.path));
    if (!info) {
      return;
    }
    const values = info.store.listForFile(info.relative);
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
    clear(key);
    const rendered: vscode.CommentThread[] = [];
    for (const item of values) {
      const pinned = repin(item.line, item.anchor, lines);
      const line = Math.max(0, Math.min(lines.length - 1, pinned.line - 1));
      const thread = controller.createCommentThread(
        uri,
        new vscode.Range(line, 0, line, 0),
        item.comments.map((c) => ({
          body: new vscode.MarkdownString(c.body),
          mode: vscode.CommentMode.Preview,
          author: { name: c.author },
        })),
      );
      thread.label = pinned.outdated ? "Local Review (outdated)" : "Local Review";
      thread.contextValue = `localReviewThread:${item.status}:${item.id}`;
      thread.state =
        item.status === "resolved"
          ? vscode.CommentThreadState.Resolved
          : vscode.CommentThreadState.Unresolved;
      thread.collapsibleState =
        item.status === "resolved"
          ? vscode.CommentThreadCollapsibleState.Collapsed
          : vscode.CommentThreadCollapsibleState.Expanded;
      thread.canReply = true;
      rendered.push(thread);
    }
    threads.set(key, rendered);
  };
  const operate = (
    thread: vscode.CommentThread,
    fn: (store: FileCommentStore, file: string, id: string) => void,
  ) => {
    const uri = thread.uri.scheme === "file" ? thread.uri : vscode.Uri.file(thread.uri.path);
    const info = storeFor(uri);
    const id = thread.contextValue?.split(":")[2];
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
  const onChange = () => {
    for (const editor of vscode.window.visibleTextEditors) {
      refreshForEditor(editor);
    }
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(onChange),
    watcher.onDidChange(onChange),
    watcher.onDidDelete(onChange),
    vscode.workspace.onDidChangeTextDocument((e) => {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === e.document) {
          refreshForEditor(editor);
        }
      }
    }),
  );
  const startCommentAtLine = async (uri: vscode.Uri, line: number) => {
    const editor = vscode.window.activeTextEditor;
    const info = storeFor(uri.scheme === "file" ? uri : vscode.Uri.file(uri.path));
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
      fs.writeFileSync(path.join(dir, "README.md"), guide, { flag: "wx" });
      const answer = await vscode.window.showInformationMessage(
        "Add .local-review/ to .gitignore?",
        "Add",
      );
      if (answer === "Add") {
        const ignore = path.join(info.folder.uri.fsPath, ".gitignore");
        let content = "";
        try {
          content = fs.readFileSync(ignore, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        if (!content.split(/\r?\n/).includes(".local-review/")) {
          fs.appendFileSync(
            ignore,
            `${content && !content.endsWith("\n") ? "\n" : ""}.local-review/\n`,
          );
        }
      }
    }
    refreshForEditor(editor);
    if (vscode.workspace.getConfiguration("localReview").get<boolean>("copyOnComment", true)) {
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
