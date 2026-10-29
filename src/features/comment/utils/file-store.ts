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
// Thread ids reach an AI prompt (Copy All) and review files can come from a cloned repo.
export const THREAD_ID_PATTERN = /^[A-Za-z0-9_:.-]{1,64}$/;
const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;
export function addReviewIgnore(root: string): void {
  const name = path.join(root, ".gitignore");
  let content: string;
  let fd: number;
  try {
    if (!fs.lstatSync(name).isFile()) {
      throw new Error(`Not a regular file: ${name}`);
    }
    fd = fs.openSync(
      name,
      fs.constants.O_RDWR |
        fs.constants.O_APPEND |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK,
    );
    if (!fs.fstatSync(fd).isFile()) {
      fs.closeSync(fd);
      throw new Error(`Not a regular file: ${name}`);
    }
    try {
      content = fs.readFileSync(fd, "utf8");
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    fd = fs.openSync(name, "wx");
    content = "";
  }
  try {
    if (!content.split(/\r?\n/).some((line) => /^\/?\.local-review(?:\/|\/\*\*)?$/.test(line))) {
      fs.writeFileSync(fd, `${content && !content.endsWith("\n") ? "\n" : ""}.local-review/\n`);
    }
  } finally {
    fs.closeSync(fd);
  }
}
const guide = `<!-- local-review guide v2 -->
# Local Review agent guide

The .local-review folder is hidden and usually gitignored, so default search may miss it.
List files with \`find .local-review -name '*.review.json'\` and look for \`"status": "open"\`.
The path .local-review/src/a.ts.review.json maps to src/a.ts.

Example .local-review/src/extension.ts.review.json:
\`\`\`json
{
  "version": 1,
  "file": "src/extension.ts",
  "threads": [{
    "id": "t_8f2a", "line": 42, "anchor": "const ctx = init();", "status": "open",
    "comments": [
      { "id": "c_01", "author": "user", "body": "check the initialization", "at": "2026-10-28T14:02:11Z" },
      { "id": "c_02", "author": "claude", "body": "Fixed: moved init before registration.", "at": "2026-10-28T14:05:40Z" }
    ]
  }]
}
\`\`\`

Reply by appending to comments: \`{"id":"c_<unique>","author":"<your agent name>","body":"...","at":"<ISO 8601 UTC>"}\`.
All four comment fields are required. Version must be integer 1, file must equal the mapped path,
and the file must be UTF-8 without a BOM; otherwise the whole file is refused.
Thread ids must be unique within a file. Do not change line or anchor; the extension re-pins them.
Resolve by setting status to "resolved" once the requested change is made; agents may resolve their own fixes.
Reopen by setting status to "open". Delete only when the user asks: remove the thread object,
and delete the file if it was the last thread. Re-read the file immediately before writing it
to avoid losing a reply made meanwhile. Preserve other fields.
`;

export class FileCommentStore {
  private readonly warnings = new Map<string, string>();
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
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) {
          throw new Error(`Symlink in review path: ${current}`);
        }
        if (current === result && !stat.isFile()) {
          throw new Error(`Review path is not a regular file: ${current}`);
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
      const fd = fs.openSync(
        name,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      let bytes: Buffer;
      try {
        if (!fs.fstatSync(fd).isFile()) {
          throw new Error(`Review path is not a regular file: ${name}`);
        }
        bytes = fs.readFileSync(fd);
      } finally {
        fs.closeSync(fd);
      }
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
        new Set(data.threads.map((t) => t.id)).size !== data.threads.length ||
        !data.threads.every(
          (t) =>
            typeof t.id === "string" &&
            THREAD_ID_PATTERN.test(t.id) &&
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
    const temp = `${name}.${randomBytes(12).toString("hex")}.tmp`;
    const fd = fs.openSync(temp, "wx");
    let failure: unknown;
    try {
      try {
        fs.writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, name);
    } catch (error) {
      failure = error;
    } finally {
      try {
        fs.unlinkSync(temp);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          failure = cleanupError;
        }
      }
    }
    if (failure) {
      throw failure instanceof Error ? failure : new Error(String(failure));
    }
    try {
      this.writeGuide();
    } catch (error) {
      this.warn(`Failed to write Local Review guide: ${error}`);
    }
  }
  private writeGuide(): void {
    const name = path.join(this.root, ".local-review", "README.md");
    let flags = fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    try {
      const stat = fs.lstatSync(name);
      if (!stat.isFile()) {
        throw new Error(`Guide is not a regular file: ${name}`);
      }
      const readFd = fs.openSync(
        name,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      try {
        if (!fs.fstatSync(readFd).isFile()) {
          throw new Error(`Guide is not a regular file: ${name}`);
        }
        if (fs.readFileSync(readFd, "utf8") === guide) {
          return;
        }
      } finally {
        fs.closeSync(readFd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      flags |= fs.constants.O_CREAT | fs.constants.O_EXCL;
    }
    const fd = fs.openSync(name, flags, 0o666);
    try {
      if (!fs.fstatSync(fd).isFile()) {
        throw new Error(`Guide is not a regular file: ${name}`);
      }
      fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, guide);
    } finally {
      fs.closeSync(fd);
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
      const result = this.read(file).threads;
      this.warnings.delete(file);
      return result;
    } catch (error) {
      this.warnOnce(file, error);
      return [];
    }
  }
  private warnOnce(file: string, error: unknown): void {
    const message = String(error);
    if (this.warnings.get(file) !== message) {
      this.warn(message);
    }
    this.warnings.set(file, message);
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
            this.warnings.delete(file);
          } catch (error) {
            this.warnOnce(file, error);
          }
        }
      }
    };
    walk(path.join(this.root, ".local-review"));
    return result;
  }
}
