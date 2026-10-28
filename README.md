# Local Review

![Local Review](https://raw.githubusercontent.com/yumazak/local-review/main/images/screenshot.png)

A VS Code extension for quickly collecting code review comments and sharing them with AI Agents like Claude Code, GitHub Copilot, or other AI assistants.

This fork is `stefanthorpe.local-review`. Uninstall upstream `yumazak.local-review` to avoid duplicate commands and keybindings.

## Why Local Review?

![Usage Demo](https://raw.githubusercontent.com/yumazak/local-review/main/images/demo.gif)

When reviewing code with AI Agents, you often need to:
1. Point out specific lines that need attention
2. Collect multiple comments across different files
3. Share all feedback in a structured format

Local Review streamlines this workflow by letting you add comments directly in VS Code and share persistent review threads with AI agents through files in the workspace.

## Features

- Add comments to any line in the editor or diff view
- Comments are displayed as VS Code discussion threads
- Save threads to `.local-review/` and see agent replies in the editor

## Usage

### Adding Comments

1. Place cursor on the line you want to comment
2. Press `Cmd+Shift+C` (macOS) or `Ctrl+Shift+C` (Windows/Linux)
3. Enter your comment and press Enter
4. The comment appears as a discussion thread on that line

### Copying All Comments

1. Press `Cmd+Shift+Enter` (macOS) or `Ctrl+Shift+Enter` (Windows/Linux)
2. A prompt listing open threads is copied to the clipboard; paste it once to your agent. Threads remain on disk and replies appear in the editor.

### Managing Threads

Use Reply to add a message, Resolve when the change is made, and Reopen to return a resolved thread to open. Click the trash icon to delete the whole thread, including replies.

## Output Format

With `copyOnComment` enabled, each new comment is copied in this format:

```
src/extension.ts:42 check the initialization
src/utils/parser.ts:15 this logic seems duplicated
```

## File format and agent workflow

Each workspace stores threads in `.local-review/<source path>.review.json`, with a workspace-relative POSIX `file` path and `version: 1`. A thread has a unique `id`, a 1-based `line`, the trimmed line text as `anchor`, an `open` or `resolved` status, and a `comments` array. Each comment has an `id`, `author`, Markdown `body`, and ISO UTC `at` timestamp. Unknown fields are preserved.

The extension writes a versioned `.local-review/README.md` guide and offers to add the directory to `.gitignore` on first use. Add comments, use Copy All, then paste the prompt once to your agent. It reads the guide and review files, replies in each thread, and may resolve its own fixes. External edits appear in the editor. Deleting the last thread removes its review file.

Threads follow matching anchor text within 50 lines; if no match is found they are marked outdated. Renaming a source file does not move its review file. Malformed or unsupported review files are skipped with a warning and are not overwritten.

## Use Cases

### Code Review with Claude Code

1. Open a diff view of changes you want to review
2. Add comments to lines that need attention
3. Ask Claude Code to read `.local-review/README.md` and the review files
4. Read replies and resolve or reopen threads in the editor

### Collecting Feedback for AI Refactoring

1. Browse through code and mark areas for improvement
2. Add comments describing what should be changed
3. Share the collected comments with your AI assistant

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| Local Review: Add Comment to Current Line | `Cmd+Shift+C` | Add a comment to the current line |
| Local Review: Copy All Comments | `Cmd+Shift+Enter` | Copy a prompt listing open review threads |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `localReview.useAbsolutePath` | `false` | Use absolute file paths instead of relative paths in comments |
| `localReview.copyOnComment` | `false` | Automatically copy comment to clipboard when adding a new comment |

### Example Configuration

```json
// .vscode/settings.json
{
  "localReview.useAbsolutePath": true,
  "localReview.copyOnComment": false
}
```

## Requirements

- Visual Studio Code 1.108.0 or higher

## Development

```bash
pnpm install
pnpm run compile
pnpm run test:unit
pnpm test
```
