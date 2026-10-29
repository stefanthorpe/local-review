---
version: 5
---

# File-Backed Review Comments - Architecture Design

**Author:** Stefan Thorpe
**Date:** 2026-10-28
**Status:** Approved
**Plan:** none separate; the Specification below is the build brief, delivered as one PR.

## Executive Summary

Local Review lets you drop comments on lines in VS Code, then copy them all to the
clipboard for an AI agent. The comments live only in memory, so every review
round means copying, pasting, and losing the thread once copied. This fork saves
each comment thread to a JSON file under `.local-review/`, mirroring the source
tree. The files become the single source of truth. An agent replies, resolves,
or deletes a thread by editing the file with its ordinary file tools, and the
extension re-renders the change live in the editor. No clipboard step, no CLI,
nothing extra to install.

## How It Works

```text
  You (VS Code)                                   AI agent (Claude Code, Copilot, ...)
  ─────────────                                   ─────────────────────────────────────
  Ctrl+Shift+C on a line                          reads .local-review/README.md (schema)
        │                                         globs .local-review/**/*.review.json
        ▼                                                         │
  ┌──────────────────┐   write (temp + rename)   ┌─────────────────▼──────────────────┐
  │ FileCommentStore │ ─────────────────────────▶│ .local-review/src/foo.ts.review.json│
  │                  │ ◀───────── watcher ────── │  threads[] → comments[]             │
  └────────┬─────────┘   (create/change/delete)  └─────────────────▲──────────────────┘
           │                                                       │
           ▼                                          agent appends a reply,
  ┌──────────────────┐                                sets status: resolved,
  │ CommentProvider  │  renders VS Code              or removes a thread
  │ (CommentThreads) │  comment threads
  └──────────────────┘
```

You add a comment; the store writes it to disk. The agent edits the same file;
the watcher sees it and the provider redraws the thread with the reply or the
new status. Both sides read and write the same file and nothing else.

## Key Decisions

### 1. The files are the store

- **Chosen:** a new `FileCommentStore` reads and writes the JSON files directly and
  replaces the in-memory store.
- **Rejected:** keep the memory store and mirror it to disk. Two copies need
  reconciling every time the agent edits, which is where the bugs would live.
- **Rejected:** write files only on "Copy All". One-way, so agent replies never
  reach the editor. Fails the goal.
- **Cost:** every operation does file I/O. Review files are small, so this is
  negligible.

### 2. One mirrored folder, not sibling files

- **Chosen:** `.local-review/<relpath>.review.json` at the store root (see Root resolution
  below; usually the git repository or worktree the file is in).
- **Rejected:** `foo.ts.review.json` next to each source file. It scatters files
  through the tree and needs a gitignore glob.
- **Rejected:** one `.local-review.json` for the workspace. Simple, but you and
  the agent editing different threads at once would collide in one file.
- **Cost:** a review file's path has to be derived from the source path; renaming
  a source file orphans its review file (see Risks).

### 3. The agent edits files directly

- **Chosen:** agents edit JSON with their normal tools, guided by a schema
  README written into `.local-review/`.
- **Rejected:** a bundled `local-review` CLI. Validated writes, but it must be on
  PATH on every machine and each agent must learn it.
- **Cost:** an agent can write malformed JSON. Handled by never overwriting a
  file that fails to parse (see Error Handling).

### 4. Threads re-pin by anchor text

- **Chosen:** each thread stores the text of its line when created. If the line
  no longer matches on load, search about ±50 lines for that text and move the
  thread there. If not found, keep the original line and mark it "(outdated)".
- **Rejected:** line number only. Any edit above the line, including the agent's
  own fix, shifts every comment below it to the wrong place.
- **Cost:** duplicate lines (e.g. `}`) can re-pin to the nearest match rather
  than the true one. Acceptable for a review aid.

### 5. Personal fork, local VSIX

- **Chosen:** fork to `stefanthorpe/local-review`, build a `.vsix` in CI,
  install it through Salt (`extras.sls`), with extension identity
  `stefanthorpe.local-review` and plain semver (`0.1.0`).
- **Rejected:** RelevantSearch org fork; Marketplace publish. Both add ownership
  overhead for a personal tool. The change can still go upstream as a PR later.
- **Cost:** updates are manual (rebuild + converge) instead of automatic.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Agent writes invalid JSON | Medium | Thread disappears from editor | Skip the file, warn with file name and parse error, never overwrite it |
| Extension's own write triggers its watcher | High | Double render, flicker | Compare rendered snapshots and skip unchanged watcher events |
| A thread body or a cloned repo's files carry prompt-injection text | Medium | Agent follows instructions it should not | Ids must match a strict pattern and a bad id refuses the whole file; Copy All installs the canonical guide first; excerpts sit in a marked untrusted-content fence. **Residual risk:** the fence is advice to a model, not enforcement, so a body can still sway an agent that reads it; only open threads the user last spoke in are sent, but the user cannot vet text an agent or collaborator wrote into the file |
| A review file claims to be the user's but is not (the `author` field is unverified, and review files can arrive in a clone or a pull) | Medium | Agent acts on a stranger's request | The prompt frames items as code-review requests that cannot override the guide and tells the agent never to run commands, install packages or fetch URLs from them without asking the user. Copy All warns when git tracks any `.local-review/*.review.json` in a folder, since those threads came from a commit. **Residual risk:** `author` is a plain string anyone can write, an untracked file placed by another process looks identical to the user's, and the framing is advice to a model |
| A review path carries shell syntax or line breaks | Medium | Quoted prompt line broken or a command smuggled into an agent's shell | Paths containing control, line/paragraph-separator or format characters, backtick, `$`, `;`, `&`, `|`, `<`, `>`, `"` or `\` are refused when a thread is added (the typed text is kept) and skipped with a named warning when found on disk; every path in the prompt is single-quoted; folder roots and guide paths pass the same check. **Residual risk:** a path may still hold `[ ] ( ) # ' @ + ,` and spaces, so the quoting, not the filter alone, protects a shell, and a model can still misread an odd path |
| Directory watch goes quiet after `.local-review/` is deleted and recreated | Medium | Agent replies stop rendering | The direct watcher closes and re-arms when its directory is gone or its inode changed |
| Source file renamed | Low | Review file orphaned | Out of scope for v1; orphan is visible on disk and can be moved by hand |
| Marketplace upstream auto-updates over the fork | Medium | Fork silently replaced | Distinct publisher and extension identity; install from VSIX only |

## Out of Scope

Editing existing comments, multi-reviewer identity beyond `author`, syncing to
GitHub PR reviews, a CLI, and handling source renames.

---

# Specification

## Current Code (upstream `b6b5733`)

- `src/features/comment/types/comment.ts` - `Comment { fileName, lineNumber, text }`, flat, no threads.
- `src/features/comment/utils/store.ts` - `CommentStore` interface (`add`, `list`,
  `listForFile`, `removeAt`, `formatAll`, `clear`, `hasAny`) over an in-memory array.
- `src/features/comment/utils/provider.ts` - maps comments to VS Code `CommentThread`s.
- `src/features/comment/utils/actions.ts` - `addComment`, `submitComments` (copy to
  clipboard, then clear the store and threads).
- Settings: `localReview.useAbsolutePath`, `localReview.copyOnComment`.

## File Schema

Path: `<root>/.local-review/<path relative to root>.review.json`, where `<root>` is the
store root from Root resolution below.

```json
{
  "version": 1,
  "file": "src/extension.ts",
  "threads": [
    {
      "id": "t_8f2a",
      "line": 42,
      "anchor": "const ctx = init();",
      "status": "open",
      "comments": [
        { "id": "c_01", "author": "user",   "body": "check the initialization", "at": "2026-10-28T14:02:11Z" },
        { "id": "c_02", "author": "claude", "body": "Fixed: moved init before registration.", "at": "2026-10-28T14:05:40Z" }
      ]
    }
  ]
}
```

| Field | Type | Rule |
|-------|------|------|
| `version` | integer | Must be `1`; other values are skipped with a warning |
| `file` | string | Workspace-relative POSIX path of the source file |
| `threads[].id` | string | Unique within the file; must match `^[A-Za-z0-9_:.-]{1,64}$` (the extension writes `t_` + random hex). One bad id refuses the whole file |
| `threads[].line` | integer | 1-based |
| `threads[].anchor` | string | Trimmed text of the line at creation |
| `threads[].status` | `open` \| `resolved` | |
| `comments[].id` | string | Unique within the thread |
| `comments[].author` | string | `user` for comments made in the editor; agent's name otherwise |
| `comments[].body` | string | Markdown |
| `comments[].at` | string | ISO 8601 UTC |

Deleting the last thread deletes the file. Unknown fields are preserved on write
so an agent's annotations survive.

## Components

| Component | Responsibility |
|-----------|----------------|
| `FileCommentStore` | Load/save review files; `addThread`, `reply`, `resolve`, `reopen`, `deleteThread`, `listForFile`, `listAll`; atomic writes (temp + rename + directory fsync) |
| `anchor` util | Pure function: given thread line + anchor + document lines, return re-pinned line and `outdated` flag |
| `CommentProvider` (extended) | One VS Code comment per thread comment; native resolved state (collapsed); Reply / Resolve / Reopen / Delete actions via `comments/commentThread/*` menus |
| Review watcher | Two layers. A `FileSystemWatcher` on `.local-review/**/*.review.json`, plus a direct non-recursive `fs.watch` fallback on the directory that holds each open document's review file, or on the nearest existing ancestor (up to the store root when `.local-review` itself is missing, with the folder watcher's create event also subscribed) before the file exists, because the recursive watcher can miss a subtree created moments earlier. On Linux `fs.watch` on a deleted directory emits `rename`, not `error`, so an entry whose directory is gone or whose inode changed is closed and re-armed. Per-document entries are dropped when the document closes, and a document's key leaves an ancestor watch once its own directory is watched. Events compare snapshot hashes and update changed threads in place |
| Agent README | `.local-review/README.md` versioned and rewritten on review writes: schema plus the three operations (append reply, set `status`, remove thread) |

## Root resolution

The agent instructions only trust a `.local-review` at a git repository or worktree top
level, and the folder VS Code has open varies (a repo, a parent such as `~/git/RS`, or a
subfolder). So the store root is derived from the file, not from the open folder
(`resolveRoot` in `utils/root.ts`, a pure function of the file path, the home directory
and the containing workspace folder):

1. If the file's real path (symlinks resolved) is under the real `<home>/git/` (a
   path-segment prefix, so `~/gitfoo` is not), walk up from its directory to the nearest
   ancestor that has a `.git` entry, a directory or a file (worktrees and clones with a
   `.git` file count), stopping at `<home>/git` itself, which is a root only if it has
   `.git`. Nearest wins, so a child clone or worktree inside a parent repo gets its own
   root.
2. If that finds no repository, or the file is not under `~/git`, the root is the
   workspace folder containing the file, as before.
3. Otherwise there is no root and the comment is refused.

The relative path is the file relative to the root with `/` separators; a path that would
start with `..` means no root. Stores are keyed by root. Copy All collects from the
union of the file-scheme workspace folders and every root the provider created a store
for this session, deduplicated by real path. The fallback `fs.watch` covers roots
outside the workspace, since the extension's `FileSystemWatcher` sees only workspace
folders.

## Behaviour Changes

- **Copy All** (`Ctrl+Shift+Enter`) copies an open-thread prompt and no longer clears anything.
- **Add comment** writes immediately. `copyOnComment` still copies the single
  comment in the old `path:line text` format when enabled; it defaults to false.
- **Needs the agent** means `status` is `open` and the last comment's author is `user`.
  Copy All lists only those threads, with the latest user comment as the excerpt,
  then an "awaiting the user" section (path, line and id only) for open threads where
  the agent spoke last. An open thread with no comments is listed for the agent. Entries
  are grouped under their quoted review file path, every path is single-quoted, and the
  prompt says to read the whole thread in its review file. Line numbers are re-pinned
  from the current source for the prompt only (nothing is written back) and marked
  "(outdated)" when the anchor is gone. A reply made in the editor sets the thread back to `open`.
- **Copy All installs the canonical guide** in each folder before emitting the prompt,
  because the prompt tells the agent to read it and a cloned repo could ship its own.
  A folder whose guide cannot be installed is left out of the prompt and reported.
  Thread excerpts are fenced as untrusted review text. Errors from several files
  collapse into one summary warning, led by any guide failure; when nothing is copied
  because folders were skipped, the message says how many.
- **First use** in a root offers to add `.local-review/` to `.gitignore`.

## Error Handling

- **Malformed file:** threads in it are not shown; a warning names the file and the
  parse error; the store refuses to write to that file until it parses again.
- **Refusal reasons:** the message names the first bad thread index and the reason
  (for example the id pattern). If the file is refused when the user adds a comment,
  the typed text is copied to the clipboard, for a reply as well as a new comment; the
  warning says whether the copy worked and repeats the text only when it did not
  (shortened when it did).
- **Refused file with threads already rendered:** the rendered threads stay until the
  file parses again; only a missing file clears them.
- **Atomic writes:** write to `<name>.tmp`, fsync it, rename over the target, then fsync
  the directory (best effort). The first error is the one thrown; a cleanup failure is
  attached as its `cause`. The guide is replaced the same way, without the directory sync.
- **Left side of a diff** (`git:` / `diff:` URIs): the warning says the side is
  read-only and not file-backed.
- **No root:** commands warn "Comments are only saved for files under ~/git or the open folder." and do nothing.

## Testing

TDD per the RS universal rules.

- Unit (`FileCommentStore`): add/reload round-trip, reply, resolve/reopen,
  delete thread, last-thread deletion removes the file, malformed file skipped and
  not overwritten, unknown fields preserved.
- Unit (`anchor`): exact match, shifted up/down within window, not found → outdated,
  nearest of duplicate matches.
- Integration (`@vscode/test`, already in the repo): an external write to a review
  file updates the rendered thread; a self-write does not double-render.

## Changelog

### v5 — 2026-10-29

- Store root is resolved per file (nearest `.git` ancestor under `~/git`, else the
  workspace folder) instead of always the workspace folder; see Root resolution.
- Copy All also collects from every root the provider stored comments in this session.
- No-root error text changed.

### v4 — 2026-10-28

- Path rule: review paths containing control, line/paragraph-separator or format
  characters, or any of backtick, `$`, `;`, `&`, `|`, `<`, `>`, `"` and `\`, are refused at
  `addThread` (the user's text is kept) and skipped with a named warning in `listAll`.
  `[ ] ( ) # '`, `@ + , . - _` and spaces stay legal, so `app/[slug]/page.tsx`,
  `pages/[...all].tsx`, `src/it's.ts` and `docs/C#.md` work. Every prompt path is
  single-quoted (`'` becomes `'\''`), folder roots and guide paths pass the same check, and
  a line-break scrub runs on each path as a second layer. Residual risk: see Risks.
- Prompt: grouped by review file, whole-thread note, empty open threads listed, excerpts
  cut by code point, "(outdated)" from a Copy-All-time re-pin that persists nothing.
  The untrusted-text sentence now frames items as code-review requests and forbids running
  commands, installing packages or fetching URLs from them without asking the user.
- Copy All warns when git tracks review files (the `author` is unverified); a skipped
  guide is reported first and as "skipped", never as "nothing needs the agent".
- Watcher falls back to the workspace folder root when `.local-review` is missing and
  subscribes to the folder create event; keys leave ancestor watches once the own
  directory is watched.
- A reply to a refused file goes to the clipboard; the toast reports the copy result.
- `save()` keeps the first error with cleanup errors as `cause` and fsyncs the directory;
  the guide is rewritten via temp file and rename. Guide v5: schema-complete one-line
  self-check and an example whose fixed thread is `resolved`.

### v3 — 2026-10-28

- Add the direct `fs.watch` fallback (also on the nearest existing ancestor before the
  review file exists) and re-arm it when its directory is deleted and recreated; drop
  per-document watcher, thread and snapshot state when a document closes.
- Restrict thread ids to `^[A-Za-z0-9_:.-]{1,64}$`; one bad id refuses the whole file,
  and the error names the thread index and reason.
- Define "needs the agent" (open, user spoke last); a user reply reopens the thread;
  Copy All lists those threads plus an awaiting-the-user section.
- Copy All installs the canonical guide before emitting its prompt (guide v3: needs-agent
  rule, id pattern, `line` is where the comment was made and `anchor` locates the code,
  self-check command, Markdown bodies).
- The prompt names the exact guide path of each folder whose guide was installed and
  omits folders that were skipped; its untrusted-text markers carry a per-prompt random
  nonce so review text cannot forge them. Review paths with control characters or shell
  metacharacters are ignored by `listAll` and the prompt, and the guide (v4) tells agents
  to quote paths and quotes the self-check path.
- Record the residual prompt-injection risk from thread bodies (see Risks).
- A refused file keeps rendered threads and the user's typed text.

### v2 — 2026-10-28

- Use `stefanthorpe.local-review` and plain semver as the extension identity.
- Suppress unchanged self-writes by snapshot comparison; refresh threads in place.
- Copy All emits a prompt listing open threads.
- Version and rewrite the agent guide; agents may resolve their own fixes.
- Default `copyOnComment` to false.

### v1 — 2026-10-28

Initial design, approved in session.
