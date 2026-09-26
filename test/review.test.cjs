const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const { createWebviewProvider } = require("./helpers.cjs");

const files = ["src/a-b.ts", "src/a_b.ts", 'docs/日本語 & "notes".md'].map(
  (path) => ({
    path,
    content: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,4 @@\n context\n-before\n+after\n+another addition\n context\n`,
    additions: 2,
    deletions: 1,
  }),
);

async function openPage(
  t,
  html,
  state,
  viewport = { width: 1100, height: 800 },
) {
  const browser = await chromium.launch({
    channel: process.env.DIFFF_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], "No client script errors"));
  await loadPage(page, html, state);
  return page;
}

async function loadPage(page, html, state = {}) {
  await page.goto("about:blank");
  await page.setContent(
    html.replace(
      "<head>",
      `<head><script>
    window.messages = [];
    window.reviewState = ${JSON.stringify(state).replace(/</g, "\\u003c")};
    window.acquireVsCodeApi = () => ({
      postMessage(message) { window.messages.push(message); },
      getState() { return window.reviewState; },
      setState(state) { window.reviewState = state; }
    });
  </script>`,
    ),
  );
  await page.waitForFunction(() =>
    window.messages.some((message) => message.command === "webviewReady"),
  );
  await page.evaluate(() => {
    window.messages = [];
  });
}

test("file filtering, navigation, collapse and editor actions work in both review modes", async (t) => {
  const provider = createWebviewProvider();
  for (const mode of ["branch", "working"]) {
    await t.test(mode, async (t) => {
      const html =
        mode === "branch"
          ? provider.getAllDiffsContent(files, "main", "feature/review")
          : provider.getWorkingDirectoryContent(files);
      const page = await openPage(t, html);
      assert.equal(await page.locator(".file-link").count(), 3);
      assert.equal(
        await page
          .locator(".file-diff")
          .evaluateAll((nodes) => new Set(nodes.map((node) => node.id)).size),
        3,
      );
      await page
        .getByRole("button", { name: "Collapse all", exact: true })
        .click();
      assert.equal(await page.locator(".file-body:visible").count(), 0);
      await page.locator(".file-link").nth(1).click();
      assert.equal(await page.locator(".file-body:visible").count(), 1);
      assert.equal(
        await page
          .locator(".file-diff")
          .nth(1)
          .locator(".file-toggle")
          .getAttribute("aria-expanded"),
        "true",
      );
      assert.deepEqual(
        await page.evaluate(() => window.messages),
        [],
        "Navigation stays in the diff",
      );
      await page.locator(".file-header-title").nth(1).click();
      assert.deepEqual(await page.evaluate(() => window.messages.pop()), {
        command: "openFile",
        filePath: files[1].path,
      });

      await page.getByRole("searchbox", { name: "Filter files" }).fill("A_B");
      assert.equal(await page.locator(".file-diff:visible").count(), 1);
      assert.equal(await page.locator(".file-link:visible").count(), 1);
      assert.equal(
        await page.locator("#visible-files").textContent(),
        "1 of 3 files",
      );
      const saved = await page.evaluate(() => window.reviewState);
      await loadPage(page, html, saved);
      assert.equal(await page.locator("#file-search").inputValue(), "A_B");
      assert.equal(await page.locator(".file-diff:visible").count(), 1);
      assert.equal(
        await page
          .locator(".file-toggle")
          .first()
          .getAttribute("aria-expanded"),
        "false",
      );
      await page.locator("#file-search").fill("does-not-exist");
      assert(
        await page
          .getByRole("heading", { name: "No matching files" })
          .isVisible(),
      );
      await page.getByRole("button", { name: "Clear filter" }).click();
      assert.equal(await page.locator(".file-diff:visible").count(), 3);
      await page.locator(".file-link").last().click();
      assert.equal(
        await page
          .locator(".file-diff")
          .last()
          .locator(".file-toggle")
          .getAttribute("aria-expanded"),
        "true",
      );
      await page.locator(".file-header-title").last().click();
      assert.deepEqual(await page.evaluate(() => window.messages.pop()), {
        command: "openFile",
        filePath: files[2].path,
      });

      await page.getByRole("button", { name: "Refresh changes" }).click();
      assert.deepEqual(await page.evaluate(() => window.messages.pop()), {
        command: "reload",
      });
      assert(await page.locator("#reload-diff-btn").isDisabled());
      await page.evaluate(() =>
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { command: "reloadComplete", success: false },
          }),
        ),
      );
      assert(await page.locator("#reload-diff-btn").isEnabled());
      assert.equal(
        await page.locator("#review-status").textContent(),
        "Refresh failed. Try again.",
      );
    });
  }
});

test("comment editing, copying, keyboard submission and deletion preserve literal content", async (t) => {
  const comment = {
    id: "comment-1",
    filePath: files[2].path,
    lineNumber: 2,
    lineType: "addition",
    content: "Keep <strong>literal</strong> & \"quotes\" and 'apostrophes'.",
    author: "Review Author",
    timestamp: Date.now(),
    baseRef: "main",
    compareRef: "feature",
  };
  const comments = new Map([[files[2].path, [comment]]]);
  const html = createWebviewProvider().getAllDiffsContent(
    files,
    "main",
    "feature",
    comments,
    '</script><script>throw new Error("injected")</script>',
  );
  const page = await openPage(t, html);
  await page.locator("#copy-comments-btn").click();
  assert.deepEqual(await page.evaluate(() => window.messages.pop()), {
    command: "copyComments",
  });
  await page.locator("[data-copy-comment]").click();
  assert.deepEqual(await page.evaluate(() => window.messages.pop()), {
    command: "copySingleComment",
    comment,
  });
  await page.locator("[data-edit-comment]").click();
  assert.equal(
    await page.locator(".comment-textarea").inputValue(),
    comment.content,
  );
  await page.locator("[data-cancel-comment]").click();
  assert.equal(
    await page.locator(".comment-content").textContent(),
    comment.content,
  );
  assert.equal(await page.locator(".comment-content strong").count(), 0);
  await page.locator("[data-edit-comment]").click();
  await page.locator(".comment-textarea").fill("Updated comment");
  await page.locator(".comment-textarea").press("Control+Enter");
  assert.deepEqual(await page.evaluate(() => window.messages.pop()), {
    command: "editComment",
    commentId: comment.id,
    content: "Updated comment",
  });
  await loadPage(page, html);
  await page.locator(".comment-thread-header").click();
  assert.equal(
    await page.locator(".comment-thread-header").getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(await page.locator(".comment-thread-body:visible").count(), 0);
  await page.locator(".comment-thread-header").press("Enter");
  await page.locator("[data-delete-comment]").click();
  assert.deepEqual(await page.evaluate(() => window.messages.pop()), {
    command: "deleteComment",
    commentId: comment.id,
  });
  await page.evaluate(
    (commentId) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { command: "commentDeleted", commentId },
        }),
      ),
    comment.id,
  );
  assert.equal(await page.locator(".comment-thread-row").count(), 0);
  assert(await page.locator("#copy-comments-btn").isDisabled());
  await page
    .locator(".file-diff")
    .last()
    .locator('.add-comment-button[data-line-type="addition"]')
    .first()
    .click();
  assert(await page.locator("[data-submit-comment]").isDisabled());
  await page.locator(".comment-textarea").fill("A new comment");
  await page.locator("[data-submit-comment]").click();
  assert.deepEqual(await page.evaluate(() => window.messages.pop()), {
    command: "addComment",
    filePath: files[2].path,
    lineNumber: 2,
    lineType: "addition",
    content: "A new comment",
  });
});

test("empty views and long paths fit narrow editors with theme colors", async (t) => {
  const provider = createWebviewProvider();
  const page = await openPage(t, provider.getWorkingDirectoryContent([]));
  assert(
    await page
      .getByRole("heading", { name: "Your working directory is clean" })
      .isVisible(),
  );
  assert(await page.locator("#collapse-all").isDisabled());
  await loadPage(page, provider.getAllDiffsContent([], "main", "feature"));
  assert(
    await page
      .getByRole("heading", { name: "No changes to review" })
      .isVisible(),
  );
  const longFiles = [
    { ...files[0], path: "src/" + "long-path-".repeat(25) + ".ts" },
  ];
  for (const width of [360, 640, 900, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await loadPage(
      page,
      provider.getAllDiffsContent(
        longFiles,
        "main",
        "feature/" + "long-branch-".repeat(20),
      ),
    );
    await page.addStyleTag({
      content:
        ":root { --vscode-editor-background: #1f1f1f; --vscode-editor-foreground: #cccccc; --vscode-sideBar-background: #181818; --vscode-panel-border: #343434; }",
    });
    const layout = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      background: getComputedStyle(document.body).backgroundColor,
    }));
    assert(
      layout.scrollWidth <= layout.width + 1,
      `Page overflow at ${width}px`,
    );
    assert.equal(layout.background, "rgb(31, 31, 31)");
  }
});

test("sidebar comment jumps reveal the exact comment through filters and collapsed sections", async (t) => {
  const provider = createWebviewProvider();
  const longFiles = Array.from({ length: 8 }, (_, index) => ({
    ...files[0],
    path: `src/file-${index}.ts`,
  }));
  const comment = {
    id: 'comment-"target',
    filePath: longFiles[6].path,
    lineNumber: 2,
    lineType: "addition",
    content: "Jump here",
    author: "Reviewer",
    timestamp: Date.now(),
  };
  const comments = new Map([
    [
      comment.filePath,
      [
        {
          ...comment,
          id: "other-comment",
          content: "Another comment on the same line",
        },
        comment,
      ],
    ],
  ]);
  for (const mode of ["branch", "working"]) {
    await t.test(mode, async (t) => {
      const html =
        mode === "branch"
          ? provider.getAllDiffsContent(longFiles, "main", "feature", comments)
          : provider.getWorkingDirectoryContent(longFiles, comments);
      const page = await openPage(t, html);
      // Reload with state restoration, just as a new webview does before ready.
      const saved = await page.evaluate(() => window.reviewState);
      await loadPage(page, html, { ...saved, scrollY: 0 });
      await page.locator(".comment-thread-header").click();
      await page
        .getByRole("button", { name: "Collapse all", exact: true })
        .click();
      await page.locator("#file-search").fill("file-0");
      await page.evaluate((commentId) => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { command: "revealComment", commentId },
          }),
        );
      }, comment.id);
      assert.equal(await page.locator("#file-search").inputValue(), "");
      assert.equal(await page.locator(".file-body:visible").count(), 1);
      assert.equal(
        await page
          .locator(".comment-thread-header")
          .getAttribute("aria-expanded"),
        "true",
      );
      assert.equal(
        await page
          .locator(".comment-highlight")
          .getAttribute("data-comment-id"),
        comment.id,
      );
      const position = await page
        .locator(".comment-highlight")
        .evaluate((item) => ({
          top: item.getBoundingClientRect().top,
          bottom: item.getBoundingClientRect().bottom,
          headerBottom: document
            .querySelector(".page-header")
            .getBoundingClientRect().bottom,
          height: innerHeight,
          scrollY,
          focused: document.activeElement === item,
        }));
      assert(position.scrollY > 0, "Scrolls down to the comment");
      assert(
        position.top >= position.headerBottom,
        "Comment clears the sticky header",
      );
      assert(
        position.bottom <= position.height,
        "Comment is within the viewport",
      );
      assert(position.focused);
      assert.deepEqual(await page.evaluate(() => window.messages.pop()), {
        command: "commentRevealed",
        commentId: comment.id,
      });
      assert(
        !(await page
          .locator(".file-diff")
          .nth(6)
          .locator(".file-body")
          .isHidden()),
      );
      const afterJump = await page.evaluate(() => window.reviewState);
      assert(!afterJump.collapsed.includes(comment.filePath));
      assert(afterJump.scrollY > 0);
      await page.evaluate(() =>
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { command: "revealComment", commentId: "missing" },
          }),
        ),
      );
      assert.equal(
        await page.locator("#review-status").textContent(),
        "This comment is no longer visible in this diff.",
      );
    });
  }
});
