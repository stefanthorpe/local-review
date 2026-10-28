---
version: 1
---

# File-Backed Review Comments - Architecture Design

**Author:** Stefan Thorpe
**Date:** 2026-10-28
**Status:** Approved
**Plan:** [Implementation plan](./2026-10-28-file-backed-comments-plan.md)

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

- **Chosen:** `.local-review/<relpath>.review.json` at the workspace root.
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
  install it through Salt (`extras.sls`), version `0.1.0-stefan.N`.
- **Rejected:** RelevantSearch org fork; Marketplace publish. Both add ownership
  overhead for a personal tool. The change can still go upstream as a PR later.
- **Cost:** updates are manual (rebuild + converge) instead of automatic.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Agent writes invalid JSON | Medium | Thread disappears from editor | Skip the file, warn with file name and parse error, never overwrite it |
| Extension's own write triggers its watcher | High | Double render, flicker | Tag self-writes and ignore the matching watcher event |
| Source file renamed | Low | Review file orphaned | Out of scope for v1; orphan is visible on disk and can be moved by hand |
| Marketplace upstream auto-updates over the fork | Medium | Fork silently replaced | Distinct version suffix; install from VSIX only |

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

Path: `<workspaceRoot>/.local-review/<path relative to root>.review.json`.

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
| `threads[].id` | string | Unique within the file; `t_` + random hex |
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
| `FileCommentStore` | Load/save review files; `addThread`, `reply`, `resolve`, `reopen`, `deleteThread`, `listForFile`, `listAll`; atomic writes (temp + rename); self-write tagging |
| `anchor` util | Pure function: given thread line + anchor + document lines, return re-pinned line and `outdated` flag |
| `CommentProvider` (extended) | One VS Code comment per thread comment; native resolved state (collapsed); Reply / Resolve / Reopen / Delete actions via `comments/commentThread/*` menus |
| Review watcher | `FileSystemWatcher` on `.local-review/**/*.review.json`; on external create/change/delete, reload that file and re-render its threads |
| Agent README | `.local-review/README.md` written on first use: schema plus the three operations (append reply, set `status`, remove thread) |

## Behaviour Changes

- **Copy All** (`Ctrl+Shift+Enter`) copies a one-line pointer -
  `Review comments are in .local-review/ — see README there` - and no longer clears anything.
- **Add comment** writes immediately. `copyOnComment` still copies the single
  comment in the old `path:line text` format.
- **First use** in a workspace offers to add `.local-review/` to `.gitignore`.

## Error Handling

- **Malformed file:** threads in it are not shown; a warning names the file and the
  parse error; the store refuses to write to that file until it parses again.
- **Atomic writes:** write to `<name>.tmp`, then rename over the target.
- **No workspace folder:** commands warn and do nothing, as upstream does for no editor.

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

### v1 — 2026-10-28

Initial design, approved in session.
