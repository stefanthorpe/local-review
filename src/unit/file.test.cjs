const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { FileCommentStore } = require("../../out/features/comment/utils/file-store");
const { repin } = require("../../out/features/comment/utils/anchor");
const { formatOpenThreads } = require("../../out/features/comment/utils/format");
const { addReviewIgnore } = require("../../out/features/comment/utils/file-store");

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

test("stale temporary files do not block writes and failed writes are cleaned up", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-"));
  try {
    const store = new FileCommentStore(root);
    fs.mkdirSync(path.join(root, ".local-review"));
    const name = store.reviewPath("a");
    fs.writeFileSync(`${name}.tmp`, "stale");
    store.addThread("a", 1, "a", "a");
    const original = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) => {
      if (typeof file === "number") {
        original(file, ...args);
        throw new Error("simulated write failure");
      }
      return original(file, ...args);
    };
    try {
      assert.throws(() => store.addThread("a", 1, "a", "b"), /simulated/);
    } finally {
      fs.writeFileSync = original;
    }
    assert.deepEqual(fs.readdirSync(path.dirname(name)).sort(), [
      "README.md",
      "a.review.json",
      "a.review.json.tmp",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate thread ids are refused and repeated warnings are deduplicated until recovery", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-"));
  try {
    const warnings = [];
    const store = new FileCommentStore(root, (message) => warnings.push(message));
    store.addThread("a", 1, "a", "a");
    const name = store.reviewPath("a");
    const valid = fs.readFileSync(name, "utf8");
    const data = JSON.parse(valid);
    data.threads.push(data.threads[0]);
    fs.writeFileSync(name, JSON.stringify(data));
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(store.listForFile("a"), []);
    }
    assert.equal(warnings.length, 1);
    assert.throws(() => store.addThread("a", 1, "a", "a"));
    fs.writeFileSync(name, valid);
    assert.equal(store.listForFile("a").length, 1);
    fs.writeFileSync(name, JSON.stringify(data));
    store.listForFile("a");
    assert.equal(warnings.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a FIFO review file is refused without blocking", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-"));
  try {
    fs.mkdirSync(path.join(root, ".local-review"));
    const fifo = path.join(root, ".local-review/a.review.json");
    const made = spawnSync("mkfifo", [fifo]);
    if (made.error && made.error.code === "ENOENT") {
      return t.skip("mkfifo unavailable");
    }
    assert.equal(made.status, 0);
    const script = `const {FileCommentStore}=require(${JSON.stringify(require.resolve("../../out/features/comment/utils/file-store"))}); new FileCommentStore(process.argv[1]).listForFile("a");`;
    const child = spawnSync(process.execPath, ["-e", script, root], { timeout: 1000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("open-thread prompt lists only open threads with single-line truncated bodies", () => {
  const folders = [
    {
      name: "one",
      files: [
        {
          file: "src/a.ts",
          threads: [
            {
              id: "t:1",
              line: 42,
              status: "open",
              comments: [{ body: "first\n" + "x".repeat(100) }],
            },
            { id: "t2", line: 3, status: "resolved", comments: [{ body: "done" }] },
          ],
        },
      ],
    },
    { name: "two", files: [] },
  ];
  const prompt = formatOpenThreads(folders);
  assert.match(prompt, /^Address the 1 open review thread in \.local-review\//);
  assert.match(prompt, /- one\/src\/a\.ts:42 \[t:1\] first x+…\nReply/);
  assert.equal(prompt.includes("done"), false);
  assert.equal(formatOpenThreads([{ name: "one", files: [] }]), undefined);
});

test("extension identity and defaults distinguish the fork", () => {
  const manifest = require("../../package.json");
  assert.equal(manifest.publisher, "stefanthorpe");
  assert.equal(manifest.name, "local-review");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.displayName, "Local Review (file-backed)");
  assert.equal(
    manifest.contributes.configuration.properties["localReview.copyOnComment"].default,
    false,
  );
});

test("every review write installs or upgrades the guide without following symlinks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  try {
    const warnings = [];
    const store = new FileCommentStore(root, (message) => warnings.push(message));
    const thread = store.addThread("a", 1, "a", "a");
    const guide = path.join(root, ".local-review/README.md");
    assert.match(fs.readFileSync(guide, "utf8"), /<!-- local-review guide v2 -->/);
    fs.writeFileSync(guide, "old guide");
    store.reply("a", thread.id, "agent", "reply");
    assert.match(fs.readFileSync(guide, "utf8"), /find \.local-review -name '\*\.review\.json'/);
    fs.unlinkSync(guide);
    const target = path.join(outside, "target");
    fs.symlinkSync(target, guide);
    store.reply("a", thread.id, "agent", "another");
    assert.equal(fs.existsSync(target), false);
    assert.equal(store.listForFile("a")[0].comments.length, 3);
    assert.equal(warnings.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("gitignore handles existing entries and refuses symlinks and special files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  try {
    const ignore = path.join(root, ".gitignore");
    for (const entry of [".local-review", "/.local-review/", ".local-review/**"]) {
      fs.writeFileSync(ignore, `${entry}\n`);
      addReviewIgnore(root);
      assert.equal(fs.readFileSync(ignore, "utf8"), `${entry}\n`);
    }
    fs.unlinkSync(ignore);
    const target = path.join(outside, "target");
    fs.writeFileSync(target, "outside");
    fs.symlinkSync(target, ignore);
    assert.throws(() => addReviewIgnore(root));
    assert.equal(fs.readFileSync(target, "utf8"), "outside");
    fs.unlinkSync(target);
    assert.throws(() => addReviewIgnore(root));
    assert.equal(fs.existsSync(target), false);
    fs.unlinkSync(ignore);
    const made = spawnSync("mkfifo", [ignore]);
    if (made.error && made.error.code === "ENOENT") {
      return t.skip("mkfifo unavailable");
    }
    assert.equal(made.status, 0);
    assert.throws(() => addReviewIgnore(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
