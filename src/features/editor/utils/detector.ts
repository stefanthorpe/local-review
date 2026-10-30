import * as vscode from "vscode";

export const getEditorFileName = (editor: vscode.TextEditor): string => {
  const uri = editor.document.uri;
  const config = vscode.workspace.getConfiguration("localReview");
  const useAbsolutePath = config.get<boolean>("useAbsolutePath", false);

  if (useAbsolutePath) {
    if (uri.scheme === "file") {
      return uri.fsPath;
    }
    if ((uri.scheme === "git" || uri.scheme === "diff") && uri.path) {
      return vscode.Uri.file(uri.path).fsPath;
    }
  }

  const isDiffScheme = isDiffEditor(editor);

  if (isDiffScheme && uri.path) {
    const fileUri = vscode.Uri.file(uri.path);
    return vscode.workspace.asRelativePath(fileUri, false);
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (workspaceFolder) {
    return vscode.workspace.asRelativePath(uri, false);
  }

  return editor.document.fileName;
};

const isDiffEditor = (editor: vscode.TextEditor): boolean => {
  const scheme = editor.document.uri.scheme;

  return scheme === "git" || scheme === "diff";
};
