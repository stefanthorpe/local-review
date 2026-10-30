const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { withProvider, withHome, wait } = require("./provider-harness.cjs");

const rangesFor = (controller, editor) =>
  controller.commentingRangeProvider.provideCommentingRanges(editor.document);

// A fake home whose ~/git/loose holds a.ts but no repository yet; no workspace folder is open.
const withLoose = async (body) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "provider-home-")));
  const loose = path.join(home, "git", "loose");
  fs.mkdirSync(loose, { recursive: true });
  const filePath = path.join(loose, "a.ts");
  fs.writeFileSync(filePath, "line\n");
  try {
    await withHome(home, () =>
      withProvider((ctx) => body({ ...ctx, home, loose }), { filePath, noWorkspace: true }),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
};

test("dispose releases every subscription, and a late watcher event renders nothing", async () => {
  await withProvider(async ({ provider, store, watched, disposables, subscriptions, created }) => {
    store.addThread("sub/a", 1, "line", "stored before the provider is gone");
    assert.ok(watched.length > 0);
    provider.dispose();
    assert.ok(subscriptions.length > 0);
    assert.ok(
      subscriptions.every((d) => d.disposed > 0),
      "every context subscription is disposed",
    );
    assert.ok(
      disposables.every((d) => d.disposed > 0),
      "every watcher, listener and command is disposed",
    );
    for (const fire of watched) {
      fire();
    }
    await wait(300);
    assert.equal(created.length, 0);
    // A second dispose (the extension context disposes its subscriptions again) is harmless.
    provider.dispose();
  });
});

test("a document with no repository gets no range until one appears, without reopening it", async () => {
  await withLoose(async ({ controller, editor, loose }) => {
    assert.equal(rangesFor(controller, editor), undefined);
    assert.equal(rangesFor(controller, editor), undefined);
    fs.mkdirSync(path.join(loose, ".git"));
    const ranges = rangesFor(controller, editor);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start.line, 0);
  });
});

test("the shortcut guard and the write path see a repository created after the document opened", async () => {
  await withLoose(async ({ provider, editor, loose, warnings, type, created, executed }) => {
    await provider.startComment(editor.document.uri);
    assert.equal(warnings.length, 1);
    assert.deepEqual(executed, []);
    fs.mkdirSync(path.join(loose, ".git"));
    await provider.startComment(editor.document.uri);
    assert.equal(warnings.length, 1);
    assert.equal(created.length, 1);
    await type("now in a repo");
    assert.ok(fs.existsSync(path.join(loose, ".local-review", "a.ts.review.json")));
  });
});

test("a repository started inside the repository after the document opened takes the comment", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "provider-home-")));
  const outer = path.join(home, "git", "outer");
  const inner = path.join(outer, "pkg");
  fs.mkdirSync(path.join(outer, ".git"), { recursive: true });
  fs.mkdirSync(inner);
  const filePath = path.join(inner, "a.ts");
  fs.writeFileSync(filePath, "line\n");
  try {
    await withHome(home, () =>
      withProvider(
        async ({ provider, controller, editor, type }) => {
          assert.equal(rangesFor(controller, editor).length, 1);
          fs.mkdirSync(path.join(inner, ".git"));
          await provider.startComment(editor.document.uri);
          await type("belongs to the nearer repo");
          assert.ok(fs.existsSync(path.join(inner, ".local-review", "a.ts.review.json")));
          assert.equal(fs.existsSync(path.join(outer, ".local-review")), false);
          assert.deepEqual(provider.roots(), [inner]);
        },
        { filePath, noWorkspace: true },
      ),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a repository that goes away stops offering the gutter plus once the watchers report it", async () => {
  await withLoose(async ({ controller, editor, loose, watched }) => {
    fs.mkdirSync(path.join(loose, ".git"));
    assert.equal(rangesFor(controller, editor).length, 1);
    fs.rmSync(path.join(loose, ".git"), { recursive: true });
    for (const fire of watched) {
      fire();
    }
    assert.equal(rangesFor(controller, editor), undefined);
  });
});
