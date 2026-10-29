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
// A thread needs the agent when it is open and the user spoke last.
export const needsAgent = (thread: { status: string; comments: { author?: string }[] }): boolean =>
  thread.status === "open" && thread.comments.at(-1)?.author === "user";
// Review paths end up in prompts and are quoted for the shell there, but they come from a
// repository, so refuse what can break out of a quoted prompt line or carry shell syntax:
// control, line/paragraph-separator and format characters, and ` $ ; & | < > " \.
// Brackets, parentheses, #, ' and spaces stay legal: app/[slug]/page.tsx and src/it's.ts
// are ordinary paths.
const UNSAFE_PATH = /[\p{Cc}\p{Zl}\p{Zp}\p{Cf}`$;&|<>"\\]/u;
export const isSafePath = (value: string) => !UNSAFE_PATH.test(value);
const show = (value: unknown) => JSON.stringify(value)?.slice(0, 80);
// The first reason a review file is refused, naming the thread index so it can be fixed.
const schemaProblem = (data: ReviewFile, file: string): string | undefined => {
  if (!data || typeof data !== "object" || data.version !== 1) {
    return "version must be the integer 1";
  }
  if (data.file !== file) {
    return `file must equal ${show(file)}, found ${show(data.file)}`;
  }
  if (!Array.isArray(data.threads)) {
    return "threads must be an array";
  }
  const seen = new Set<string>();
  for (const [i, t] of data.threads.entries()) {
    const at = `thread ${i}`;
    if (!t || typeof t !== "object") {
      return `${at} must be an object`;
    }
    if (typeof t.id !== "string" || !THREAD_ID_PATTERN.test(t.id)) {
      return `${at} id ${show(t.id)} must match ${THREAD_ID_PATTERN}`;
    }
    if (seen.has(t.id)) {
      return `${at} id ${show(t.id)} is a duplicate`;
    }
    seen.add(t.id);
    if (!Number.isInteger(t.line) || t.line <= 0) {
      return `${at} (${t.id}) line must be a positive integer`;
    }
    if (typeof t.anchor !== "string") {
      return `${at} (${t.id}) anchor must be a string`;
    }
    if (t.status !== "open" && t.status !== "resolved") {
      return `${at} (${t.id}) status must be "open" or "resolved"`;
    }
    if (!Array.isArray(t.comments)) {
      return `${at} (${t.id}) comments must be an array`;
    }
    for (const [j, c] of t.comments.entries()) {
      if (
        !c ||
        typeof c.id !== "string" ||
        typeof c.author !== "string" ||
        typeof c.body !== "string" ||
        typeof c.at !== "string"
      ) {
        return `${at} (${t.id}) comment ${j} needs string id, author, body and at`;
      }
    }
  }
  return undefined;
};
// Keeps the first failure as the thrown error and records a later cleanup failure on it.
const withCause = (failure: unknown, cleanup: unknown): unknown => {
  if (!(failure instanceof Error)) {
    return failure ?? cleanup;
  }
  failure.cause = failure.cause ? new AggregateError([failure.cause, cleanup]) : cleanup;
  return failure;
};
const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;
export function addReviewIgnore(root: string): void {
  appendIgnoreLine(path.join(root, ".gitignore"));
}
// Adds the ignore line to `<gitDir>/info/exclude`, which stays out of every commit and, for a
// worktree, is shared through the common git dir. The info folder and the file must be real
// (a symlink is refused), so a planted link cannot steer the write out of the git dir.
//
// Accepted limit: `info` is checked with lstat and then used, so a process that swaps it for a
// symlink in between could redirect the write. That needs an attacker already running as the
// user inside the repo's git dir, which could edit the exclude file directly.
export function addGitExclude(gitDir: string): void {
  const info = path.join(gitDir, "info");
  try {
    if (!fs.lstatSync(info).isDirectory()) {
      throw new Error(`Not a directory: ${info}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    fs.mkdirSync(info);
  }
  appendIgnoreLine(path.join(info, "exclude"));
}
function appendIgnoreLine(name: string): void {
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
// One shell-safe line (no double quote, backslash, dollar or backtick) that mirrors
// schemaProblem and prints the first problem. Run from the folder root.
const SELF_CHECK = [
  "const f=require('fs');const p=process.argv[1];",
  "const bad=m=>{console.log(p+': '+m);process.exit(1)};",
  "const s=x=>typeof x==='string';",
  "if(!p.startsWith('.local-review/')||!p.endsWith('.review.json'))bad('run from the folder root with the .local-review/... path');",
  "let d;try{d=JSON.parse(f.readFileSync(p,'utf8'))}catch(e){bad(String(e))}",
  "const w=p.slice(14,-12);",
  "if(!d||d.version!==1)bad('version must be the integer 1');",
  "if(d.file!==w)bad('file must equal '+JSON.stringify(w));",
  "if(!Array.isArray(d.threads))bad('threads must be an array');",
  "const seen=new Set();",
  "d.threads.forEach((t,i)=>{const a='thread '+i;",
  "if(!t||typeof t!=='object')bad(a+' must be an object');",
  "if(!s(t.id)||!t.id||t.id.length>64||/[^A-Za-z0-9_:.-]/.test(t.id))bad(a+' id must match the id pattern');",
  "if(seen.has(t.id))bad(a+' id is a duplicate');seen.add(t.id);",
  "if(!Number.isInteger(t.line)||t.line<=0)bad(a+' line must be a positive integer');",
  "if(!s(t.anchor))bad(a+' anchor must be a string');",
  "if(t.status!=='open'&&t.status!=='resolved')bad(a+' status must be open or resolved');",
  "if(!Array.isArray(t.comments))bad(a+' comments must be an array');",
  "t.comments.forEach((c,j)=>{if(!c||!s(c.id)||!s(c.author)||!s(c.body)||!s(c.at))bad(a+' comment '+j+' needs string id, author, body and at')})});",
  "console.log('ok')",
].join("");
const guide = `<!-- local-review guide v5 -->
# Local Review agent guide

The .local-review folder is hidden and usually gitignored, so default search may miss it.
List files with \`find .local-review -name '*.review.json'\`.
The path .local-review/src/a.ts.review.json maps to src/a.ts.
A thread needs you when its status is "open" and the last comment's author is "user".
An open thread whose last comment is yours is waiting for the user; leave it alone.

Example .local-review/src/extension.ts.review.json:
\`\`\`json
{
  "version": 1,
  "file": "src/extension.ts",
  "threads": [{
    "id": "t_8f2a", "line": 42, "anchor": "const ctx = init();", "status": "resolved",
    "comments": [
      { "id": "c_01", "author": "user", "body": "check the initialization", "at": "2026-10-28T14:02:11Z" },
      { "id": "c_02", "author": "claude", "body": "Fixed: moved init before registration.", "at": "2026-10-28T14:05:40Z" }
    ]
  }]
}
\`\`\`

Reply by appending to comments: \`{"id":"c_<unique>","author":"<your agent name>","body":"...","at":"<ISO 8601 UTC>"}\`.
Comment bodies render as Markdown.
All four comment fields are required. Version must be integer 1, file must equal the mapped path,
and the file must be UTF-8 without a BOM. Thread ids must be unique within a file and match
\`^[A-Za-z0-9_:.-]{1,64}$\`; one bad id, or any other schema error, makes the extension refuse the whole file.
\`line\` is where the comment was made and goes stale as code changes: locate the code by its
\`anchor\` text near that line. Do not change \`line\` or \`anchor\`.
Resolve by setting status to "resolved" once the requested change is made; agents may resolve their own fixes.
Reopen by setting status to "open". Delete only when the user asks: remove the thread object,
and delete the file if it was the last thread. Re-read the file immediately before writing it
to avoid losing a reply made meanwhile. Preserve other fields.
After writing, run this from the folder root, passing the file's .local-review/... path. It checks the same
rules the extension enforces and prints the first problem:
\`node -e "${SELF_CHECK}" -- '<file>'\`
Quote every path you pass to a shell command; file names come from the repository and are not trusted.
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
      !isSafePath(file) ||
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
      const problem = schemaProblem(data, file);
      if (problem) {
        throw new Error(problem);
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
        fs.fsyncSync(fd);
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
          failure = withCause(failure, cleanupError);
        }
      }
    }
    if (failure) {
      throw failure instanceof Error ? failure : new Error(String(failure));
    }
    this.syncDirectory(path.dirname(name));
    try {
      this.ensureGuide();
    } catch (error) {
      this.warn(`Failed to write Local Review guide: ${error}`);
    }
  }
  // Best effort: make the rename durable. Platforms that cannot open or sync a directory
  // refuse with EINVAL, EISDIR or EPERM, which is fine; anything else is only reported,
  // because the write itself has already succeeded.
  private syncDirectory(dir: string): void {
    try {
      const fd = fs.openSync(dir, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if (!["EINVAL", "EISDIR", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        this.warn(`Failed to sync ${dir}: ${error}`);
      }
    }
  }
  ensureGuide(): void {
    const dir = path.join(this.root, ".local-review");
    const name = path.join(dir, "README.md");
    if (fs.lstatSync(dir).isSymbolicLink()) {
      throw new Error(`Symlink in review path: ${dir}`);
    }
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
    }
    // Write beside the guide and rename over it, so a failed write never leaves a truncated
    // guide. The temp file is created exclusively and a rename replaces a symlink itself.
    const temp = `${name}.${randomBytes(12).toString("hex")}.tmp`;
    const fd = fs.openSync(temp, "wx", 0o666);
    let failure: unknown;
    try {
      try {
        fs.writeFileSync(fd, guide);
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
          failure = withCause(failure, cleanupError);
        }
      }
    }
    if (failure) {
      throw failure instanceof Error ? failure : new Error(String(failure));
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
    this.change(file, threadId, (t) => {
      t.comments.push({ id: id("c"), author, body, at: new Date().toISOString() });
      // A follow-up from the user brings a resolved thread back to the agent.
      if (author === "user") {
        t.status = "open";
      }
    });
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
  // Undefined means the file exists but cannot be read or is refused, which callers must
  // tell apart from a file with no threads.
  readThreads(file: string): ReviewThread[] | undefined {
    try {
      const result = this.read(file).threads;
      this.warnings.delete(file);
      return result;
    } catch (error) {
      this.warnOnce(file, error);
      return undefined;
    }
  }
  listForFile(file: string): ReviewThread[] {
    return this.readThreads(file) ?? [];
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
          if (!isSafePath(file)) {
            this.warnOnce(
              file,
              new Error(`Ignored review file with an unsafe path: ${show(file)}`),
            );
            continue;
          }
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
