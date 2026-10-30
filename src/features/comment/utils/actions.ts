import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { CommentAction } from "../types/context";
import { discoverReviewRoots } from "./discover";
import { isNoRepository, ownGitDir, runGit } from "./git";
import { repin } from "./anchor";
import { FileCommentStore, isSafePath } from "./file-store";
import { formatOpenThreads } from "./format";

export const addComment: CommentAction = async (ctx) => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active editor found");
    return;
  }

  await ctx.commentProvider.startComment(editor.document.uri);
};

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

type Tracking = "tracked" | "untracked" | "unknown";

// Whether git tracks anything in this folder's `.local-review/`. Tracked files came from a
// commit, so they may be someone else's, and so may the README the prompt points at. A folder
// is untracked only when it has no `.git` entry at all and git itself says it is not in a
// repository. Whatever git answers for a folder that has a `.git` entry is trusted only once
// the git dir is vouched for (a cloned repo can ship a `.git` file that points git anywhere);
// a missing git, a timeout, a refusal such as dubious ownership or any other failure is
// unknown, never assumed safe.
const trackingOf = async (root: string): Promise<Tracking> => {
  try {
    const { stdout } = await runGit(root, [
      "--literal-pathspecs",
      "ls-files",
      "-z",
      "--",
      ".local-review",
    ]);
    if (!(await ownGitDir(root).catch(() => undefined))) {
      return "unknown";
    }
    return stdout.split("\0").some(Boolean) ? "tracked" : "untracked";
  } catch (error) {
    return isNoRepository(root, error) ? "untracked" : "unknown";
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

// The real path, or undefined when the folder does not exist.
const realOf = (dir: string): string | undefined => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return undefined;
  }
};

export const submitComments: CommentAction = async (ctx) => {
  // Every place threads can live: the open folders, the repositories under them, the
  // repositories under ~/git (so Copy All sees what the agents' own search sees), and the roots
  // used this session. Deduplicated by real path.
  const problems: string[] = [];
  const workspaces = (vscode.workspace.workspaceFolders ?? []).filter(
    (folder) => folder.uri.scheme === "file",
  );
  const gitHome = realOf(path.join(os.homedir(), "git"));
  const starts = [...(gitHome ? [gitHome] : []), ...workspaces.map((folder) => folder.uri.fsPath)];
  const discovered = (
    await Promise.all(
      starts.map(async (start) => {
        const { roots, stoppedAfter } = await discoverReviewRoots(start);
        if (stoppedAfter !== undefined) {
          problems.push(`stopped searching ${start} after ${stoppedAfter} folders`);
        }
        return roots;
      }),
    )
  ).flat();
  const candidates = [
    ...workspaces.map((folder) => ({ name: folder.name, root: folder.uri.fsPath })),
    ...[...discovered, ...ctx.commentProvider.roots()].map((root) => ({
      name: path.basename(root),
      root,
    })),
  ];
  const seen = new Set<string>();
  const folders = candidates.filter(({ root }) => {
    const real = realOf(root) ?? root;
    if (seen.has(real)) {
      return false;
    }
    seen.add(real);
    return true;
  });
  if (!folders.length && !problems.length) {
    vscode.window.showWarningMessage(
      "Comments are only saved for files under ~/git or the open folder.",
    );
    return;
  }
  const guideProblems: string[] = [];
  const skipped: { root: string; reason: string }[] = [];
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
    if (!isSafePath(root)) {
      problems.push(
        `Skipped ${folder.name}: its path ${JSON.stringify(root)} has characters that are unsafe to put in a prompt`,
      );
      continue;
    }
    // A tracked or unverifiable folder may hold someone else's files, so nothing is written
    // there and its threads stay out of the prompt. This runs before the guide is installed.
    const tracking = await trackingOf(root);
    if (tracking !== "untracked") {
      const reason = tracking === "tracked" ? "tracked by git" : "could not verify";
      skipped.push({ root, reason });
      problems.push(
        tracking === "tracked"
          ? `Skipped ${folder.name}: .local-review/ is tracked by git, so these threads may not be yours`
          : `Skipped ${folder.name}: could not verify whether git tracks .local-review/`,
      );
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
  const prompt = formatOpenThreads(reviewed, skipped);
  const summary = `${all.length} Local Review ${all.length === 1 ? "problem" : "problems"}: ${all.join(" | ")}`;
  if (!prompt && guideProblems.length) {
    void vscode.window.showWarningMessage(
      `Nothing copied: ${guideProblems.length} ${guideProblems.length === 1 ? "folder skipped" : "folders skipped"} because the Local Review guide cannot be installed. ${all.join(" | ")}`,
    );
    return;
  }
  if (all.length) {
    void vscode.window.showWarningMessage(summary);
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
