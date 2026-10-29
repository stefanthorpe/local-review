const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { withProvider, wait, until } = require("./provider-harness.cjs");

test("dir watcher re-arms after .local-review is deleted and recreated", async () => {
  await withProvider(async ({ root, editor, provider, created, store }) => {
    store.addThread("sub/a", 1, "line", "body");
    provider.refreshForEditor(editor);
    assert.equal(created.length, 1);
    fs.rmSync(path.join(root, ".local-review"), { recursive: true });
    await wait(200);
    store.addThread("sub/a", 1, "line", "second");
    provider.refreshForEditor(editor);
    const thread = created.at(-1);
    store.reply("sub/a", store.listForFile("sub/a")[0].id, "agent", "external reply");
    await until(() => thread.comments.length === 2);
    assert.equal(thread.comments.length, 2);
  });
});

test("fallback watcher renders a first review file created after the editor opened", async () => {
  await withProvider(async ({ root, editor, provider, created, store }) => {
    fs.mkdirSync(path.join(root, ".local-review"));
    provider.refreshForEditor(editor);
    assert.equal(created.length, 0);
    store.addThread("sub/a", 1, "line", "agent-made");
    await until(() => created.length === 1);
    assert.equal(created.length, 1);
  });
});

test("closing a document drops its rendered threads", async () => {
  await withProvider(async ({ editor, provider, handlers, created, store }) => {
    store.addThread("sub/a", 1, "line", "body");
    provider.refreshForEditor(editor);
    handlers.close(editor.document);
    assert.equal(created[0].disposed, 1);
    provider.refreshForEditor(editor);
    assert.equal(created.length, 2);
  });
});

test("agent creates .local-review/sub/a.review.json when no .local-review exists", async () => {
  await withProvider(async ({ root, editor, provider, created, store }) => {
    provider.refreshForEditor(editor);
    assert.equal(created.length, 0);
    assert.equal(fs.existsSync(path.join(root, ".local-review")), false);
    store.addThread("sub/a", 1, "line", "agent-made");
    await until(() => created.length === 1);
    assert.equal(created.length, 1);
  });
});

test("a document's key leaves the ancestor watcher once its own directory is watched", async () => {
  const original = fs.watch;
  const opened = [];
  fs.watch = (dir, ...args) => {
    const watcher = original(dir, ...args);
    const entry = { dir, closed: false };
    const close = watcher.close.bind(watcher);
    watcher.close = () => {
      entry.closed = true;
      close();
    };
    opened.push(entry);
    return watcher;
  };
  try {
    await withProvider(async ({ root, editor, provider }) => {
      provider.refreshForEditor(editor);
      assert.deepEqual(
        opened.map((e) => e.dir),
        [root],
      );
      fs.mkdirSync(path.join(root, ".local-review", "sub"), { recursive: true });
      provider.refreshForEditor(editor);
      assert.equal(opened.at(-1).dir, path.join(root, ".local-review", "sub"));
      assert.equal(opened[0].closed, true);
      assert.equal(opened.at(-1).closed, false);
    });
  } finally {
    fs.watch = original;
  }
});
