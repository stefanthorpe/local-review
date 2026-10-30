const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { withProvider, withHome } = require("./provider-harness.cjs");

const EXPANDED = 1;
const COLLAPSED = 0;
const live = (created) => created.filter((t) => !t.disposed);
const drafts = (created) => live(created).filter((t) => t.contextValue === "localReviewDraft");
const stored = (created) => live(created).filter((t) => /^localReviewThread:/.test(t.contextValue));

test("starting a comment opens an expanded empty draft at the line and no quick input", async () => {
  await withProvider(async ({ editor, provider, created, inputBoxes, store, warnings }) => {
    editor.document.lineCount = 5;
    await provider.startCommentAtLine(editor.document.uri, 3);
    assert.equal(created.length, 1);
    const draft = created[0];
    assert.deepEqual(draft.comments, []);
    assert.equal(draft.range.start.line, 3);
    assert.equal(draft.collapsibleState, EXPANDED);
    assert.equal(draft.canReply, true);
    assert.equal(draft.contextValue, "localReviewDraft");
    assert.equal(draft.disposed, 0);
    assert.deepEqual(inputBoxes, []);
    assert.deepEqual(warnings, []);
    assert.equal(store.listForFile("sub/a").length, 0);
  });
});

test("a second request for the same line reuses the open draft", async () => {
  await withProvider(async ({ editor, provider, created }) => {
    editor.document.lineCount = 5;
    await provider.startCommentAtLine(editor.document.uri, 2);
    created[0].collapsibleState = COLLAPSED;
    await provider.startCommentAtLine(editor.document.uri, 2);
    assert.equal(created.length, 1);
    assert.equal(created[0].collapsibleState, EXPANDED);
    await provider.startCommentAtLine(editor.document.uri, 4);
    assert.equal(created.length, 2);
  });
});

test("submitting text on a draft stores one thread and swaps the draft for it", async () => {
  await withProvider(async ({ editor, provider, created, store, type }) => {
    editor.document.lineCount = 5;
    editor.document.lineAt = (i) => ({ text: `text ${i}` });
    await provider.startCommentAtLine(editor.document.uri, 3);
    const draft = created[0];
    await type("  fix this  ");
    const threads = store.listForFile("sub/a");
    assert.equal(threads.length, 1);
    assert.equal(threads[0].line, 4);
    assert.equal(threads[0].anchor, "text 3");
    assert.equal(threads[0].comments.length, 1);
    assert.equal(threads[0].comments[0].author, "user");
    assert.equal(threads[0].comments[0].body, "fix this");
    assert.equal(draft.disposed, 1);
    assert.equal(drafts(created).length, 0);
    assert.equal(stored(created).length, 1);
    assert.equal(stored(created)[0].comments.length, 1);
    // The line can be commented on again afterwards.
    await provider.startCommentAtLine(editor.document.uri, 3);
    assert.equal(drafts(created).length, 1);
  });
});

test("an empty or whitespace submit writes nothing and keeps the draft", async () => {
  await withProvider(async ({ editor, provider, created, store, type, root }) => {
    await provider.startCommentAtLine(editor.document.uri, 0);
    await type("");
    await type(" \n\t ");
    assert.equal(store.listForFile("sub/a").length, 0);
    assert.equal(fs.existsSync(path.join(root, ".local-review")), false);
    assert.equal(created[0].disposed, 0);
  });
});

test("a thread VS Code made from the gutter plus is stored on submit", async () => {
  await withProvider(async ({ editor, created, commands, controller, store }) => {
    editor.document.lineCount = 5;
    editor.document.lineAt = (i) => ({ text: `text ${i}` });
    const thread = controller.createCommentThread(
      editor.document.uri,
      { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
      [],
    );
    await commands["localReview.reply"]({ thread, text: "from the gutter" });
    const threads = store.listForFile("sub/a");
    assert.equal(threads.length, 1);
    assert.equal(threads[0].line, 3);
    assert.equal(threads[0].anchor, "text 2");
    assert.equal(threads[0].comments[0].author, "user");
    assert.equal(threads[0].comments[0].body, "from the gutter");
    assert.equal(thread.disposed, 1);
    assert.equal(stored(created).length, 1);
    await commands["localReview.reply"]({
      thread: controller.createCommentThread(editor.document.uri, thread.range, []),
      text: "   ",
    });
    assert.equal(store.listForFile("sub/a").length, 1);
  });
});

test("replying to a stored thread still appends to it, not a draft path", async () => {
  await withProvider(async ({ editor, provider, created, commands, store, type }) => {
    await provider.startCommentAtLine(editor.document.uri, 0);
    await type("first");
    const thread = stored(created)[0];
    await commands["localReview.reply"]({ thread, text: "second" });
    const threads = store.listForFile("sub/a");
    assert.equal(threads.length, 1);
    assert.deepEqual(
      threads[0].comments.map((c) => c.body),
      ["first", "second"],
    );
  });
});

test("copyOnComment copies the submitted comment", async () => {
  await withProvider(
    async ({ editor, provider, clipboard, type }) => {
      await provider.startCommentAtLine(editor.document.uri, 0);
      assert.deepEqual(clipboard, []);
      await type("copy me");
      assert.equal(clipboard.length, 1);
      assert.match(clipboard[0], /copy me/);
    },
    { copyOnComment: true },
  );
  await withProvider(async ({ editor, provider, clipboard, type }) => {
    await provider.startCommentAtLine(editor.document.uri, 0);
    await type("do not copy");
    assert.deepEqual(clipboard, []);
  });
});

test("a refused write keeps the text on the clipboard and leaves the draft open", async () => {
  await withProvider(async ({ editor, provider, created, warnings, clipboard, store, type }) => {
    store.addThread("sub/a", 1, "line", "seed");
    const file = store.reviewPath("sub/a");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.threads[0].id = "bad id";
    fs.writeFileSync(file, JSON.stringify(data));
    await provider.startCommentAtLine(editor.document.uri, 0);
    await type("my typed comment");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /my typed comment/);
    assert.deepEqual(clipboard, ["my typed comment"]);
    assert.equal(created[0].disposed, 0);
  });
});

test("the diff read-only side and unstorable documents warn and open no draft", async () => {
  await withProvider(async ({ editor, provider, created, warnings }) => {
    await provider.startCommentAtLine({ ...editor.document.uri, scheme: "git" }, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /read-only/);
    await provider.startCommentAtLine({ ...editor.document.uri, scheme: "untitled" }, 0);
    assert.equal(warnings.length, 2);
    assert.equal(created.length, 0);
  });
});

test("a refresh disposes a collapsed empty draft but not one being typed in", async () => {
  await withProvider(async ({ editor, provider, created, store }) => {
    editor.document.lineCount = 5;
    await provider.startCommentAtLine(editor.document.uri, 1);
    await provider.startCommentAtLine(editor.document.uri, 3);
    created[0].collapsibleState = COLLAPSED;
    provider.refreshForEditor(editor);
    assert.equal(created[0].disposed, 1);
    assert.equal(created[1].disposed, 0);
    assert.equal(store.listForFile("sub/a").length, 0);
    // The collapsed line can be started again with a fresh draft.
    await provider.startCommentAtLine(editor.document.uri, 1);
    assert.equal(drafts(created).length, 2);
  });
});

test("the gutter plus covers a workspace file and nothing else", async () => {
  await withProvider(async ({ editor, controller }) => {
    editor.document.lineCount = 7;
    const ranges = controller.commentingRangeProvider.provideCommentingRanges(editor.document);
    assert.equal(ranges.length, 1);
    assert.deepEqual([ranges[0].start.line, ranges[0].end.line], [0, 6]);
    for (const scheme of ["untitled", "git", "diff", "vscode-remote"]) {
      const document = { ...editor.document, uri: { ...editor.document.uri, scheme } };
      assert.equal(controller.commentingRangeProvider.provideCommentingRanges(document), undefined);
    }
  });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "provider-gutter-"));
  try {
    await withProvider(
      async ({ editor, controller }) => {
        assert.equal(
          controller.commentingRangeProvider.provideCommentingRanges(editor.document),
          undefined,
        );
      },
      { filePath: path.join(outside, "a.ts"), noWorkspace: true },
    );
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("the gutter plus covers a file in a ~/git repository", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "provider-gutter-home-")));
  try {
    const repo = path.join(home, "git", "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(home, "git", "loose"), { recursive: true });
    await withHome(home, async () => {
      await withProvider(
        async ({ editor, controller }) => {
          assert.equal(
            controller.commentingRangeProvider.provideCommentingRanges(editor.document).length,
            1,
          );
        },
        { filePath: path.join(repo, "a.ts"), noWorkspace: true },
      );
      await withProvider(
        async ({ editor, controller }) => {
          assert.equal(
            controller.commentingRangeProvider.provideCommentingRanges(editor.document),
            undefined,
          );
        },
        { filePath: path.join(home, "git", "loose", "a.ts"), noWorkspace: true },
      );
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
