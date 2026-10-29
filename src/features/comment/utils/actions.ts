import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { CommentAction } from "../types/context";
import { getCurrentLineInfo } from "../../editor/utils/detector";
import { repin } from "./anchor";
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

const execFileAsync = promisify(execFile);
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

// Whether git tracks review files in this folder. Tracked files came from a commit, so they
// may be someone else's, and the "user" author is unverified. A missing git, a folder that
// is not a repository or a timeout all count as untracked.
const hasTrackedReviews = async (root: string): Promise<boolean> => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["--literal-pathspecs", "ls-files", "-z", "--", ".local-review"],
      { cwd: root, env, timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.split("\0").some((name) => name.endsWith(".review.json"));
  } catch {
    return false;
  }
};

// The source file's lines, or undefined when it is missing, special, huge or unreadable.
const sourceLines = (root: string, file: string): string[] | undefined => {
  const name = path.join(root, ...file.split("/"));
  try {
    const stat = fs.lstatSync(name);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) {
      return undefined;
    }
    return fs.readFileSync(name, "utf8").split(/\r?\n/);
  } catch {
    return undefined;
  }
};

export const submitComments: CommentAction = async (ctx) => {
  // Workspace folders plus every root the provider stored comments in this session (roots
  // under ~/git need not be open folders), deduplicated by real path.
  const candidates = [
    ...(vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) => ({ name: folder.name, root: folder.uri.fsPath })),
    ...(ctx.commentProvider?.roots() ?? []).map((root) => ({ name: path.basename(root), root })),
  ];
  const seen = new Set<string>();
  const folders = candidates.filter(({ root }) => {
    let real = root;
    try {
      real = fs.realpathSync(root);
    } catch {
      // A root that no longer exists is still listed once, by its own path.
    }
    if (seen.has(real)) {
      return false;
    }
    seen.add(real);
    return true;
  });
  if (!folders.length) {
    vscode.window.showWarningMessage(
      "Comments are only saved for files under ~/git or the open folder.",
    );
    return;
  }
  const guideProblems: string[] = [];
  const problems: string[] = [];
  const collect = (message: string) => problems.push(message);
  const reviewed = [];
  for (const folder of folders) {
    const root = folder.root;
    const store = new FileCommentStore(root, collect);
    const files = store.listAll();
    if (!files.some((file) => file.threads.length)) {
      reviewed.push({ name: folder.name, root, files });
      continue;
    }
    // The prompt points the agent at this folder's README, and a cloned repo can ship its
    // own, so make it the canonical guide first or leave the folder out of the prompt.
    try {
      store.ensureGuide();
    } catch (error) {
      guideProblems.push(`Skipped ${folder.name}: cannot install the Local Review guide: ${error}`);
      reviewed.push({ name: folder.name, root, files: [] });
      continue;
    }
    if (await hasTrackedReviews(root)) {
      problems.push(
        `.local-review/ in ${folder.name} is tracked by git, so these threads may not be yours; check them before acting`,
      );
    }
    // Line numbers are re-pinned for this prompt only; the review files are never rewritten.
    const pinned = files.map((file) => {
      const lines = sourceLines(root, file.file);
      return {
        file: file.file,
        threads: file.threads.map((thread) => {
          const where = lines ? repin(thread.line, thread.anchor, lines) : undefined;
          return { ...thread, line: where?.line ?? thread.line, outdated: where?.outdated };
        }),
      };
    });
    reviewed.push({
      name: folder.name,
      root,
      files: pinned,
      guidePath: path.join(root, ".local-review", "README.md"),
    });
  }
  const all = [...guideProblems, ...problems];
  const prompt = formatOpenThreads(reviewed);
  if (!prompt && guideProblems.length) {
    void vscode.window.showWarningMessage(
      `Nothing copied: ${guideProblems.length} ${guideProblems.length === 1 ? "folder skipped" : "folders skipped"} because the Local Review guide cannot be installed. ${guideProblems[0]}`,
    );
    return;
  }
  if (all.length) {
    void vscode.window.showWarningMessage(
      `${all.length} Local Review ${all.length === 1 ? "problem" : "problems"}; first: ${all[0]}`,
    );
  }
  if (!prompt) {
    void vscode.window.showInformationMessage("No review threads need the agent");
    return;
  }
  const success = await ctx.copyToClipboard(prompt);
  if (!success) {
    vscode.window.showErrorMessage("Failed to copy to clipboard");
  }
};
