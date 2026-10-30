const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
);
const { commands, menus } = manifest.contributes;

test("the first box button reads Add Comment and the later one Reply", () => {
  assert.equal(commands.find((c) => c.command === "localReview.add")?.title, "Add Comment");
  assert.equal(commands.find((c) => c.command === "localReview.reply")?.title, "Reply");
  const context = menus["comments/commentThread/context"];
  assert.equal(context.length, 2);
  assert.equal(
    context.find((m) => m.command === "localReview.add")?.when,
    "commentController == localReview && commentThreadIsEmpty",
  );
  assert.equal(
    context.find((m) => m.command === "localReview.reply")?.when,
    "commentController == localReview && !commentThreadIsEmpty",
  );
});

test("the add button is hidden from the command palette", () => {
  assert.deepEqual(
    menus.commandPalette.find((m) => m.command === "localReview.add"),
    { command: "localReview.add", when: "false" },
  );
});
