# Change Log

All notable changes to this extension are listed here.

## [0.1.1]

- Copy All finds repos under `~/git` and under the open folders by searching for `.local-review`, instead of remembering roots between sessions.
- Copy All skips a folder where git tracks `.local-review/` or cannot be asked. It writes nothing there and names the folder in the prompt and the warning.
- The search stops after 20000 folders and says which folder it gave up on.
- The ignore offer asks git first, writes only to the repo's own private `.git/info/exclude`, and falls back to `.gitignore` only outside a repo.
- A reply typed for a thread with no store root is no longer lost.
- Clearer messages when a comment cannot be saved.
- Linux and macOS only: git is not run on Windows.

## [0.1.0]

- First release of the file-backed fork (`stefanthorpe.local-review`).
- Comments are saved as `.local-review/<path>.review.json` at the git repo or worktree root, so agents can read, reply to and resolve them.
- Copy All copies a prompt listing the open threads.
