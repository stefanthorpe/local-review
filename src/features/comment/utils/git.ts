import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Runs git in `cwd` with an argv array (no shell). A resolved root can be any `.git` under
// ~/git, including one a cloned repo planted, and git runs repo-local config such as
// core.fsmonitor during even read-only commands, so that is switched off for every call. The
// caller's GIT_* variables are dropped so they cannot redirect git to another repository, and
// the locale is pinned so error text can be matched.
//
// Windows is refused without spawning: a bare `git` there looks in the working directory before
// PATH, and that directory is the untrusted one. This fork supports Linux and macOS only.
export const runGit = async (
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> => {
  if (process.platform === "win32") {
    throw new Error("Running git is not supported on Windows");
  }
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    LC_ALL: "C",
  };
  return execFileAsync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    env,
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
};

// The git dir that holds this folder's private exclude file, or undefined when it cannot be
// vouched for. A cloned repo can ship a `.git` file that points git anywhere, so the common
// dir git reports is used only when it is this folder's own: the `.git` directory of the repo,
// or the common dir of a repo that really lists this folder as one of its worktrees.
export const ownGitDir = async (root: string): Promise<string | undefined> => {
  const { stdout: common } = await runGit(root, ["rev-parse", "--git-common-dir"]);
  const commonDir = fs.realpathSync(path.resolve(root, common.replace(/\r?\n$/, "")));
  let anchor = root;
  if (!fs.existsSync(path.join(root, ".git"))) {
    // No `.git` of its own: the folder sits inside a repo, whose top level is the anchor.
    const { stdout: top } = await runGit(root, ["rev-parse", "--show-toplevel"]);
    anchor = fs.realpathSync(top.replace(/\r?\n$/, ""));
  }
  const dotGit = path.join(anchor, ".git");
  const stat = fs.lstatSync(dotGit);
  if (stat.isDirectory()) {
    return fs.realpathSync(dotGit) === commonDir ? commonDir : undefined;
  }
  if (!stat.isFile() || path.basename(commonDir) !== ".git") {
    return undefined;
  }
  const { stdout: listing } = await runGit(root, ["worktree", "list", "--porcelain"]);
  const realAnchor = fs.realpathSync(anchor);
  const listed = listing
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .some((line) => {
      try {
        return fs.realpathSync(line.slice("worktree ".length)) === realAnchor;
      } catch {
        return false;
      }
    });
  return listed ? commonDir : undefined;
};

// Whether the folder has a `.git` entry of any kind, valid or not.
const hasDotGit = (root: string): boolean => {
  try {
    fs.lstatSync(path.join(root, ".git"));
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code !== "ENOENT";
  }
};

// Whether a failed git command means "there is no repository here": exit 128 with git's
// "(or any of the parent directories)" wording, for a folder with no `.git` entry of its own.
// The `not a git repository: <path>` wording means git found a `.git`, possibly in an ancestor,
// and rejected it, which is a broken repository and never "no repository".
export const isNoRepository = (root: string, error: unknown): boolean => {
  const { code, stderr } = error as { code?: unknown; stderr?: unknown };
  return (
    code === 128 &&
    /not a git repository \(or any of the parent directories\)/i.test(String(stderr ?? "")) &&
    !hasDotGit(root)
  );
};
