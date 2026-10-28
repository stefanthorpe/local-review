const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FileCommentStore } = require("../../out/features/comment/utils/file-store");
const { repin } = require("../../out/features/comment/utils/anchor");

test("thread lifecycle and preservation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-"));
  try {
    const store = new FileCommentStore(root);
    const thread = store.addThread("src/a.ts", 2, " line ", "hello");
    assert.equal(store.listForFile("src/a.ts")[0].anchor, "line");
    const file = path.join(root, ".local-review/src/a.ts.review.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.extra = "kept";
    data.threads[0].extra = 42;
    fs.writeFileSync(file, JSON.stringify(data));
    store.reply("src/a.ts", thread.id, "agent", "reply");
    store.resolve("src/a.ts", thread.id);
    assert.equal(store.listAll()[0].threads[0].status, "resolved");
    store.reopen("src/a.ts", thread.id);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.extra, "kept");
    assert.equal(saved.threads[0].extra, 42);
    assert.equal(saved.threads[0].comments.length, 2);
    store.deleteThread("src/a.ts", thread.id);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("malformed files are not overwritten and paths stay within root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-"));
  try {
    const store = new FileCommentStore(root);
    store.addThread('a "[x].ts', 1, "x", "x");
    const file = path.join(root, '.local-review/a "[x].ts.review.json');
    fs.writeFileSync(file, "{broken");
    assert.throws(() => store.addThread('a "[x].ts', 1, "x", "x"));
    assert.equal(fs.readFileSync(file, "utf8"), "{broken");
    assert.throws(() => store.addThread("../escape", 1, "x", "x"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("anchor finds exact, closest shifted and outdated lines", () => {
  assert.deepEqual(repin(2, "b", ["a", "b", "c"]), { line: 2, outdated: false });
  assert.deepEqual(repin(2, "b", ["b", "a", "c"]), { line: 1, outdated: false });
  assert.deepEqual(repin(2, "b", ["a", "c", "b"]), { line: 3, outdated: false });
  assert.deepEqual(repin(3, "b", ["b", "a", "x", "b"]), { line: 4, outdated: false });
  assert.deepEqual(repin(1, "z", ["a"]), { line: 1, outdated: true });
});

test("caller text round-trips without normalization", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-"));
  try {
    const store = new FileCommentStore(root);
    const body = "a\r\nb\rc\0\ufeff" + "z".repeat(1024 * 1024 + 1);
    const item = store.addThread('space "\n[glob].ts', 1, "anchor", body);
    assert.equal(store.listForFile('space "\n[glob].ts')[0].comments[0].body, body);
    store.reply('space "\n[glob].ts', item.id, "agent", "");
    assert.equal(store.listForFile('space "\n[glob].ts')[0].comments[1].body, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid encoding, unsupported version and symlink escapes are refused", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  try {
    const warnings = [];
    const store = new FileCommentStore(root, (warning) => warnings.push(warning));
    store.addThread("a", 1, "a", "a");
    const file = store.reviewPath("a");
    for (const bytes of [
      Buffer.from([0xff]),
      Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
      Buffer.from('{"version":2,"file":"a","threads":[]}'),
    ]) {
      fs.writeFileSync(file, bytes);
      assert.deepEqual(store.listForFile("a"), []);
      assert.throws(() => store.addThread("a", 1, "a", "a"));
      assert.deepEqual(fs.readFileSync(file), bytes);
    }
    assert.equal(warnings.length, 3);
    fs.symlinkSync(outside, path.join(root, ".local-review/link"));
    assert.throws(() => store.addThread("link/escape", 1, "a", "a"));
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.throws(() => store.reviewPath("/absolute"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
