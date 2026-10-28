import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

interface ReviewComment {
  id: string;
  author: string;
  body: string;
  at: string;
  [key: string]: unknown;
}
interface ReviewThread {
  id: string;
  line: number;
  anchor: string;
  status: "open" | "resolved";
  comments: ReviewComment[];
  [key: string]: unknown;
}
interface ReviewFile {
  version: 1;
  file: string;
  threads: ReviewThread[];
  [key: string]: unknown;
}
const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;

export class FileCommentStore {
  constructor(
    public readonly root: string,
    private readonly warn: (message: string) => void = () => {},
  ) {}

  reviewPath(file: string): string {
    if (
      !file ||
      path.isAbsolute(file) ||
      file.includes("\0") ||
      file.split(/[\\/]/).some((part) => part === ".." || part === "." || !part)
    ) {
      throw new Error(`Invalid source path: ${file}`);
    }
    const base = path.join(this.root, ".local-review");
    const result = path.join(base, ...file.split("/")) + ".review.json";
    // Refuse symlinks in existing path components, including the review root.
    let current = this.root;
    for (const part of path.relative(this.root, result).split(path.sep)) {
      current = path.join(current, part);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          throw new Error(`Symlink in review path: ${current}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    return result;
  }
  private read(file: string): ReviewFile {
    const name = this.reviewPath(file);
    let raw: string;
    try {
      const bytes = fs.readFileSync(name);
      if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
        throw new Error("UTF-8 BOM is unsupported");
      }
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, file, threads: [] };
      }
      throw new Error(`${name}: ${error}`, { cause: error });
    }
    try {
      const data = JSON.parse(raw) as ReviewFile;
      if (
        !data ||
        data.version !== 1 ||
        data.file !== file ||
        !Array.isArray(data.threads) ||
        !data.threads.every(
          (t) =>
            typeof t.id === "string" &&
            Number.isInteger(t.line) &&
            t.line > 0 &&
            typeof t.anchor === "string" &&
            (t.status === "open" || t.status === "resolved") &&
            Array.isArray(t.comments) &&
            t.comments.every(
              (c) =>
                typeof c.id === "string" &&
                typeof c.author === "string" &&
                typeof c.body === "string" &&
                typeof c.at === "string",
            ),
        )
      ) {
        throw new Error("Invalid review schema or version");
      }
      return data;
    } catch (error) {
      throw new Error(`${name}: ${error}`, { cause: error });
    }
  }
  private save(data: ReviewFile): void {
    const name = this.reviewPath(data.file);
    if (!data.threads.length) {
      try {
        fs.unlinkSync(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      return;
    }
    fs.mkdirSync(path.dirname(name), { recursive: true });
    const temp = `${name}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
    try {
      fs.renameSync(temp, name);
    } catch (error) {
      fs.unlinkSync(temp);
      throw error;
    }
  }
  addThread(file: string, line: number, anchor: string, body: string): ReviewThread {
    const data = this.read(file);
    const thread: ReviewThread = {
      id: id("t"),
      line,
      anchor: anchor.trim(),
      status: "open",
      comments: [{ id: id("c"), author: "user", body, at: new Date().toISOString() }],
    };
    data.threads.push(thread);
    this.save(data);
    return thread;
  }
  private change(file: string, threadId: string, fn: (thread: ReviewThread) => void): void {
    const data = this.read(file);
    const thread = data.threads.find((t) => t.id === threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    fn(thread);
    this.save(data);
  }
  reply(file: string, threadId: string, author: string, body: string): void {
    this.change(file, threadId, (t) =>
      t.comments.push({ id: id("c"), author, body, at: new Date().toISOString() }),
    );
  }
  resolve(file: string, threadId: string): void {
    this.change(file, threadId, (t) => {
      t.status = "resolved";
    });
  }
  reopen(file: string, threadId: string): void {
    this.change(file, threadId, (t) => {
      t.status = "open";
    });
  }
  deleteThread(file: string, threadId: string): void {
    const data = this.read(file);
    data.threads = data.threads.filter((t) => t.id !== threadId);
    this.save(data);
  }
  listForFile(file: string): ReviewThread[] {
    try {
      return this.read(file).threads;
    } catch (error) {
      this.warn(String(error));
      return [];
    }
  }
  listAll(): ReviewFile[] {
    const result: ReviewFile[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return;
        }
        throw error;
      }
      for (const entry of entries) {
        const name = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(name);
        } else if (entry.isFile() && entry.name.endsWith(".review.json")) {
          const file = path
            .relative(path.join(this.root, ".local-review"), name)
            .slice(0, -".review.json".length)
            .split(path.sep)
            .join("/");
          try {
            result.push(this.read(file));
          } catch (error) {
            this.warn(String(error));
          }
        }
      }
    };
    walk(path.join(this.root, ".local-review"));
    return result;
  }
}
