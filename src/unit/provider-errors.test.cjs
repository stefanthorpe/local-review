const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { withProvider } = require("./provider-harness.cjs");

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
