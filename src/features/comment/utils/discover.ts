import * as fs from "node:fs";
import * as path from "node:path";

// A `.local-review` entry may sit at most this many levels below the folder, the same bound the
// agents' own `find -maxdepth` uses, so Copy All and the agents see the same set.
const MAX_DEPTH = 5;
const PRUNED = new Set(["node_modules", ".git", ".venv"]);

// Folders at or below `folder` that hold a `.local-review` directory and are a repository or
// worktree (a `.git` entry, directory or file) or the folder itself. Symlinked directories are
// not followed, and package and VCS folders are not entered, so a planted link or dependency
// cannot widen the search.
export const discoverReviewRoots = async (folder: string): Promise<string[]> => {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const holdsReviews = entries.some((e) => e.name === ".local-review" && e.isDirectory());
    if (holdsReviews && (dir === folder || entries.some((e) => e.name === ".git"))) {
      found.push(dir);
    }
    if (depth + 1 >= MAX_DEPTH) {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !PRUNED.has(entry.name) && entry.name !== ".local-review") {
        await walk(path.join(dir, entry.name), depth + 1);
      }
    }
  };
  await walk(folder, 0);
  return found;
};
