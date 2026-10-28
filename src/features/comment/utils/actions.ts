import * as vscode from "vscode";
import type { CommentAction } from "../types/context";
import { getCurrentLineInfo } from "../../editor/utils/detector";

export const addComment: CommentAction = async (ctx) => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active editor found");
    return;
  }

  const lineInfo = getCurrentLineInfo();
  if (!lineInfo) {
    vscode.window.showWarningMessage("No active editor found");
    return;
  }

  await ctx.commentProvider.startCommentAtLine(editor.document.uri, lineInfo.lineNumber);
};

export const submitComments: CommentAction = async (ctx) => {
  if (!vscode.workspace.workspaceFolders?.length) {
    vscode.window.showWarningMessage("No workspace folder found");
    return;
  }
  const success = await ctx.copyToClipboard(
    "Review comments are in .local-review/ — see README there",
  );
  if (!success) {
    vscode.window.showErrorMessage("Failed to copy to clipboard");
  }
};
