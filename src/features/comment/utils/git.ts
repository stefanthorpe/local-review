import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Runs git in `cwd` with an argv array (no shell). A resolved root can be any `.git` under
// ~/git, including one a cloned repo planted, and git runs repo-local config such as
// core.fsmonitor during even read-only commands, so that is switched off for every call. The
// caller's GIT_* variables are dropped so they cannot redirect git to another repository.
export const runGit = async (
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return execFileAsync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    env,
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
};
