import * as vscode from "vscode";
import type { CommentAction } from "../types/context";
import { getCurrentLineInfo } from "../../editor/utils/detector";
import { FileCommentStore } from "./file-store";
import { formatOpenThreads } from "./format";

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
  const folders = vscode.workspace.workspaceFolders.filter(
    (folder) => folder.uri.scheme === "file",
  );
  const prompt = formatOpenThreads(
    folders.map((folder) => ({
      name: folder.name,
      files: new FileCommentStore(
        folder.uri.fsPath,
        (message) => void vscode.window.showWarningMessage(message),
      ).listAll(),
    })),
  );
  if (!prompt) {
    void vscode.window.showInformationMessage("No open review threads found");
    return;
  }
  const success = await ctx.copyToClipboard(prompt);
  if (!success) {
    vscode.window.showErrorMessage("Failed to copy to clipboard");
  }
};
