const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { withProvider, withHome } = require("./provider-harness.cjs");

const live = (created) => created.filter((t) => !t.disposed);
const boxes = (created) => live(created).filter((t) => t.contextValue === undefined);
const stored = (created) => live(created).filter((t) => /^localReviewThread:/.test(t.contextValue));
const ADD = "workbench.action.addComment";

test("starting a comment hands over to VS Code's add-comment command and creates no thread itself", async () => {
  await withProvider(
    async ({ editor, provider, created, executed, inputBoxes, store, warnings }) => {
      editor.document.lineCount = 5;
      editor.selection.active.line = 3;
      await provider.startCommentAtLine(editor.document.uri);
      assert.deepEqual(executed, [ADD]);
      // The one thread is the template VS Code makes; the provider adds nothing of its own.
      assert.equal(created.length, 1);
      assert.equal(created[0].range.start.line, 3);
      assert.equal(created[0].contextValue, undefined);
      assert.deepEqual(inputBoxes, []);
      assert.deepEqual(warnings, []);
      assert.equal(store.listForFile("sub/a").length, 0);
    },
  );
});

test("every guard still refuses before the command runs", async () => {
  await withProvider(async ({ editor, provider, executed, warnings }) => {
    await provider.startCommentAtLine({ ...editor.document.uri, scheme: "git" });
    assert.match(warnings[0], /read-only/);
    await provider.startCommentAtLine({ ...editor.document.uri, scheme: "diff" });
    await provider.startCommentAtLine({ ...editor.document.uri, scheme: "untitled" });
    await provider.startCommentAtLine({ ...editor.document.uri, scheme: "vscode-remote" });
    assert.equal(warnings.length, 4);
    assert.deepEqual(executed, []);
  });
  await withProvider(
    async ({ editor, provider, executed, warnings }) => {
      await provider.startCommentAtLine(editor.document.uri);
      assert.equal(warnings.length, 1);
      assert.deepEqual(executed, []);
    },
    { noEditor: true },
  );
});

test("submitting text in the template box stores one thread and clears the box", async () => {
  await withProvider(async ({ editor, provider, created, store, type }) => {
    editor.document.lineCount = 5;
    editor.document.lineAt = (i) => ({ text: `text ${i}` });
    editor.selection.active.line = 3;
    await provider.startCommentAtLine(editor.document.uri);
    const box = created[0];
    await type("  fix this  ");
    const threads = store.listForFile("sub/a");
    assert.equal(threads.length, 1);
    assert.equal(threads[0].line, 4);
    assert.equal(threads[0].anchor, "text 3");
    assert.equal(threads[0].comments.length, 1);
    assert.equal(threads[0].comments[0].author, "user");
    assert.equal(threads[0].comments[0].body, "fix this");
    assert.equal(box.disposed, 1);
    assert.equal(boxes(created).length, 0);
    assert.equal(stored(created).length, 1);
    assert.equal(stored(created)[0].comments.length, 1);
  });
});

test("a second submit of the same box stores nothing more", async () => {
  await withProvider(async ({ editor, provider, created, commands, store }) => {
    await provider.startCommentAtLine(editor.document.uri);
    const box = created[0];
    await commands["localReview.reply"]({ thread: box, text: "once" });
    await commands["localReview.reply"]({ thread: box, text: "once" });
    await provider.submitReply({ thread: box, text: "once" });
    const threads = store.listForFile("sub/a");
    assert.equal(threads.length, 1);
    assert.equal(threads[0].comments.length, 1);
    assert.equal(stored(created).length, 1);
  });
});

test("two submits racing on one box store one thread", async () => {
  await withProvider(async ({ editor, provider, created, store }) => {
    await provider.startCommentAtLine(editor.document.uri);
    const box = created[0];
    await Promise.all([
      provider.submitReply({ thread: box, text: "race" }),
      provider.submitReply({ thread: box, text: "race" }),
    ]);
    assert.equal(store.listForFile("sub/a").length, 1);
  });
});

test("an empty or whitespace submit says so, writes nothing and leaves the box", async () => {
  await withProvider(async ({ editor, provider, created, store, type, root, prompts }) => {
    await provider.startCommentAtLine(editor.document.uri);
    await type("");
    await type(" \n\t ");
    assert.deepEqual(prompts, ["Empty comment not saved.", "Empty comment not saved."]);
    assert.equal(store.listForFile("sub/a").length, 0);
    assert.equal(fs.existsSync(path.join(root, ".local-review")), false);
    assert.equal(created[0].disposed, 0);
    // The same box still takes a real comment afterwards.
    await type("now real");
    assert.equal(store.listForFile("sub/a").length, 1);
  });
});

test("the stored comment renders before the first-use ignore prompt is answered", async () => {
  let renderedAtPrompt;
  await withProvider(
    async ({ editor, provider, created, type }) => {
      await provider.startCommentAtLine(editor.document.uri);
      await type("show me");
      assert.equal(renderedAtPrompt, 1);
      assert.equal(stored(created).length, 1);
    },
    {
      answer: "no",
      onPrompt: (message, created) => {
        if (/^(Ignore|Add) \.local-review/.test(message)) {
          renderedAtPrompt = stored(created).length;
        }
      },
    },
  );
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
    assert.equal(threads[0].comments[0].body, "from the gutter");
    assert.equal(thread.disposed, 1);
    assert.equal(stored(created).length, 1);
  });
});

test("replying to a stored thread still appends to it", async () => {
  await withProvider(async ({ editor, provider, created, commands, store, type }) => {
    await provider.startCommentAtLine(editor.document.uri);
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
      await provider.startCommentAtLine(editor.document.uri);
      assert.deepEqual(clipboard, []);
      await type("copy me");
      assert.equal(clipboard.length, 1);
      assert.match(clipboard[0], /copy me/);
    },
    { copyOnComment: true },
  );
  await withProvider(async ({ editor, provider, clipboard, type }) => {
    await provider.startCommentAtLine(editor.document.uri);
    await type("do not copy");
    assert.deepEqual(clipboard, []);
  });
});

test("a refused write keeps the text on the clipboard and leaves the box open for a retry", async () => {
  await withProvider(async ({ editor, provider, created, warnings, clipboard, store, type }) => {
    store.addThread("sub/a", 1, "line", "seed");
    const file = store.reviewPath("sub/a");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.threads[0].id = "bad id";
    fs.writeFileSync(file, JSON.stringify(data));
    await provider.startCommentAtLine(editor.document.uri);
    await type("my typed comment");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /my typed comment/);
    assert.deepEqual(clipboard, ["my typed comment"]);
    assert.equal(created[0].disposed, 0);
    data.threads[0].id = "t1";
    fs.writeFileSync(file, JSON.stringify(data));
    await type("my typed comment");
    assert.equal(created[0].disposed, 1);
  });
});

test("the range provider resolves a document once until it closes or the folders change", async () => {
  await withProvider(async ({ editor, controller, folderLookups, handlers }) => {
    editor.document.lineCount = 3;
    const ranges = () =>
      controller.commentingRangeProvider.provideCommentingRanges(editor.document);
    assert.equal(ranges().length, 1);
    const afterFirst = folderLookups.length;
    assert.ok(afterFirst >= 1);
    assert.equal(ranges().length, 1);
    assert.equal(ranges().length, 1);
    assert.equal(folderLookups.length, afterFirst, "repeat calls hit the cache");
    handlers.close(editor.document);
    assert.equal(ranges().length, 1);
    assert.equal(folderLookups.length, afterFirst + 1, "closing the document drops its entry");
    ranges();
    assert.equal(folderLookups.length, afterFirst + 1);
    handlers.folders({ added: [], removed: [] });
    ranges();
    assert.equal(folderLookups.length, afterFirst + 2, "a folder change drops every entry");
  });
});

test("the cache never lets a file answer for a document with another scheme", async () => {
  await withProvider(async ({ editor, controller }) => {
    const provide = (document) =>
      controller.commentingRangeProvider.provideCommentingRanges(document);
    assert.equal(provide(editor.document).length, 1);
    const untitled = { ...editor.document, uri: { ...editor.document.uri, scheme: "untitled" } };
    assert.equal(provide(untitled), undefined);
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
