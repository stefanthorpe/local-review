const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { withProvider, until } = require("./provider-harness.cjs");

test("malformed write keeps existing threads rendered", async () => {
  await withProvider(async ({ editor, provider, created, store }) => {
    store.addThread("sub/a", 1, "line", "body");
    provider.refreshForEditor(editor);
    const thread = created[0];
    fs.writeFileSync(store.reviewPath("sub/a"), "{broken");
    provider.refreshForEditor(editor);
    assert.equal(thread.disposed, 0);
    assert.equal(thread.comments.length, 1);
    fs.writeFileSync(
      store.reviewPath("sub/a"),
      JSON.stringify({ version: 1, file: "sub/a", threads: [] }),
    );
    provider.refreshForEditor(editor);
    assert.equal(thread.disposed, 1);
  });
});

test("addThread on a refused file preserves the user's text and names the bad id", async () => {
  await withProvider(
    async ({ editor, provider, warnings, clipboard, store }) => {
      store.addThread("sub/a", 1, "line", "seed");
      const name = store.reviewPath("sub/a");
      const data = JSON.parse(fs.readFileSync(name, "utf8"));
      data.threads[0].id = "bad id";
      fs.writeFileSync(name, JSON.stringify(data));
      await provider.startCommentAtLine(editor.document.uri, 0);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /my typed comment/);
      assert.match(warnings[0], /"bad id"/);
      assert.match(warnings[0], /thread 0/);
      assert.deepEqual(clipboard, ["my typed comment"]);
    },
    { input: "my typed comment" },
  );
});

test("a comment from the read-only git side says so instead of blaming the workspace", async () => {
  await withProvider(async ({ editor, provider, warnings }) => {
    await provider.startCommentAtLine({ ...editor.document.uri, scheme: "git" }, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /read-only/);
    assert.doesNotMatch(warnings[0], /No workspace folder/);
  });
});

const refuse = (store) => {
  const name = store.reviewPath("sub/a");
  const data = JSON.parse(fs.readFileSync(name, "utf8"));
  data.threads[0].id = "bad id";
  fs.writeFileSync(name, JSON.stringify(data));
};

test("reply on a refused review file puts the reply text on the clipboard", async () => {
  await withProvider(
    async ({ editor, provider, commands, created, warnings, clipboard, store }) => {
      store.addThread("sub/a", 1, "line", "seed");
      provider.refreshForEditor(editor);
      refuse(store);
      commands["localReview.reply"]({ thread: created[0], text: "my reply" });
      await until(() => warnings.length > 0);
      assert.deepEqual(clipboard, ["my reply"]);
      assert.match(warnings[0], /my reply/);
      assert.match(warnings[0], /copied to the clipboard/);
      assert.match(warnings[0], /"bad id"/);
    },
    { registerCommands: true },
  );
});

test("the save-failure toast is honest about a failed copy and never embeds a long comment", async () => {
  const long = "word ".repeat(2000);
  await withProvider(
    async ({ editor, provider, warnings, store }) => {
      store.addThread("sub/a", 1, "line", "seed");
      refuse(store);
      await provider.startCommentAtLine(editor.document.uri, 0);
      assert.ok(warnings[0].length < 600);
      assert.match(warnings[0], /copied to the clipboard/);
    },
    { input: long },
  );
  await withProvider(
    async ({ editor, provider, warnings, store }) => {
      store.addThread("sub/a", 1, "line", "seed");
      refuse(store);
      await provider.startCommentAtLine(editor.document.uri, 0);
      assert.doesNotMatch(warnings[0], /was copied/);
      assert.match(warnings[0], /could not be copied/);
      assert.match(warnings[0], /my typed comment/);
    },
    { input: "my typed comment", copyOk: false },
  );
});
