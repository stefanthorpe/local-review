import * as fs from "node:fs";
import * as path from "node:path";

interface ResolvedRoot {
  root: string;
  relative: string;
}

// The real path of `target`, resolving as much of it as exists so a file that has not been
// created yet is still judged by where its existing ancestors really live.
const realLoose = (target: string): string => {
  const pending: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...pending);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(target);
      }
      pending.unshift(path.basename(current));
      current = parent;
    }
  }
};

const relativeInside = (parent: string, child: string): string | undefined => {
  const relative = path.relative(parent, child);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
};

// Picks the folder that owns a file's `.local-review` directory. Under `<home>/git` that is the
// nearest ancestor holding a `.git` entry (a directory, or a file for worktrees), so each clone
// and worktree gets its own root whatever folder VS Code has open. Anywhere else, or when no
// repository is found, it is the workspace folder containing the file. Undefined means the file
// has no root and nothing can be stored for it.
export const resolveRoot = (
  filePath: string,
  home: string,
  workspacePath: string | undefined,
): ResolvedRoot | undefined => {
  const realFile = realLoose(filePath);
  const gitHome = path.join(realLoose(home), "git");
  if (relativeInside(gitHome, realFile) !== undefined) {
    for (let dir = path.dirname(realFile); ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, ".git"))) {
        const relative = relativeInside(dir, realFile);
        return relative === undefined ? undefined : { root: dir, relative };
      }
      if (dir === gitHome || dir === path.dirname(dir)) {
        break;
      }
    }
  }
  if (workspacePath) {
    const relative = relativeInside(workspacePath, filePath);
    if (relative !== undefined) {
      return { root: workspacePath, relative };
    }
  }
  return undefined;
};
