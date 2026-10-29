import { execFile } from "node:child_process";
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
