import * as fs from "node:fs";
import * as path from "node:path";

// A `.local-review` entry may sit at most this many levels below the start folder (the start
// folder's own is level 1), the same bound as the agents' `find <start> -maxdepth 5`, so Copy All
// and the agents see the same set.
const MAX_DEPTH = 5;
// Folders that hold dependencies or build output; a `.git` in them is never a project's own.
const PRUNED = new Set([
  "node_modules",
  ".git",
  ".venv",
  "dist",
  "out",
  "build",
  ".vite",
  "coverage",
  ".next",
  ".vscode-test",
  "test-results",
]);
const MAX_DIRS = 20000;

// Folders at or below `folder` that hold a `.local-review` directory and are a repository or
// worktree (a `.git` entry, directory or file) or the folder itself. Symlinked directories are
// not followed and the pruned folders are not entered, so a planted link or dependency cannot
// widen the search. Sibling folders are read in parallel. After `maxDirs` folders the search
// stops and `stoppedAfter` says how many were read; the roots found so far are still returned.
export const discoverReviewRoots = async (
  folder: string,
  { maxDirs = MAX_DIRS }: { maxDirs?: number } = {},
): Promise<{ roots: string[]; stoppedAfter?: number }> => {
  const roots: string[] = [];
  let visited = 0;
  let stopped = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (visited >= maxDirs) {
      stopped = true;
      return;
    }
    visited++;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const holdsReviews = entries.some((e) => e.name === ".local-review" && e.isDirectory());
    if (holdsReviews && (dir === folder || entries.some((e) => e.name === ".git"))) {
      roots.push(dir);
    }
    if (depth + 1 >= MAX_DEPTH) {
      return;
    }
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !PRUNED.has(e.name) && e.name !== ".local-review")
        .map((e) => walk(path.join(dir, e.name), depth + 1)),
    );
  };
  await walk(folder, 0);
  roots.sort();
  return stopped ? { roots, stoppedAfter: visited } : { roots };
};
