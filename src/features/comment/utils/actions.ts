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
  const problems: string[] = [];
  const collect = (message: string) => problems.push(message);
  const reviewed = folders.map((folder) => {
    const store = new FileCommentStore(folder.uri.fsPath, collect);
    const files = store.listAll();
    if (files.some((file) => file.threads.length)) {
      // The prompt tells the agent to trust this folder's README, and a cloned repo can
      // ship its own, so make it the canonical guide first or leave the folder out.
      try {
        store.ensureGuide();
      } catch (error) {
        problems.push(`Skipped ${folder.name}: cannot install the Local Review guide: ${error}`);
        return { name: folder.name, files: [] };
      }
    }
    return { name: folder.name, files };
  });
  if (problems.length) {
    void vscode.window.showWarningMessage(
      `${problems.length} Local Review ${problems.length === 1 ? "problem" : "problems"}; first: ${problems[0]}`,
    );
  }
  const prompt = formatOpenThreads(reviewed);
  if (!prompt) {
    void vscode.window.showInformationMessage("No review threads need the agent");
    return;
  }
  const success = await ctx.copyToClipboard(prompt);
  if (!success) {
    vscode.window.showErrorMessage("Failed to copy to clipboard");
  }
};
