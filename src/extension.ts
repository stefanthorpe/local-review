import * as vscode from "vscode";
import { copyToClipboard } from "./features/clipboard/utils/clipboard-manager";
import { createCommentProvider } from "./features/comment/utils/provider";
import type { CommentContext } from "./features/comment/types/context";
import { addComment, submitComments } from "./features/comment/utils/actions";

export function activate(context: vscode.ExtensionContext) {
  console.log("Local Review extension is now active");

  const commentProvider = createCommentProvider(context, copyToClipboard);

  const ctx: CommentContext = {
    commentProvider,
    copyToClipboard,
  };

  commentProvider.refreshForEditor(vscode.window.activeTextEditor);

  context.subscriptions.push(
    vscode.commands.registerCommand("local-review.addComment", async () => {
      try {
        await addComment(ctx);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to add comment: ${error}`);
      }
    }),
    vscode.commands.registerCommand("local-review.submitComments", async () => {
      try {
        await submitComments(ctx);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to submit comments: ${error}`);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      commentProvider.refreshForEditor(editor);
    }),
    { dispose: () => commentProvider.dispose() },
  );
}

export function deactivate() {
  // Cleanup
}
