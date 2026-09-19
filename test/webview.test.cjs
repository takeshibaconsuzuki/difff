const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const { createWebviewProvider } = require("./helpers.cjs");

test("all diff views wrap prose and long tokens without clipping at narrow widths", async (t) => {
  const browser = await chromium.launch({
    channel: process.env.DIFFF_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const prose = "A long line with spaces and indentation. ".repeat(20);
  const token = "x".repeat(1000);
  const content = `diff --git a/example.md b/example.md\n--- a/example.md\n+++ b/example.md\n@@ -1,1 +1,2 @@ function ${token}\n-old line\n+    ${prose}\n+${token}\n`;
  const provider = createWebviewProvider();
  const files = [{ path: "example.md", content, additions: 2, deletions: 1 }];
  const variants = [
    provider.getWebviewContent(content, "example.md"),
    provider.getAllDiffsContent(files, "main", "feature"),
    provider.getWorkingDirectoryContent(files),
  ];
  for (const width of [360, 640, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [variant, html] of variants.entries()) {
      await page.setContent(
        html.replace(
          "<head>",
          "<head><script>window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });</script>",
        ),
      );
      const layout = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        table: document
          .querySelector(".diff-table")
          .getBoundingClientRect()
          .toJSON(),
        cells: [
          ...document.querySelectorAll(
            ".diff-line-addition .diff-line-content",
          ),
        ].map((cell) => ({
          width: cell.clientWidth,
          scrollWidth: cell.scrollWidth,
          height: cell.getBoundingClientRect().height,
          lineHeight: parseFloat(getComputedStyle(cell).lineHeight),
          whiteSpace: getComputedStyle(cell).whiteSpace,
          text: cell.textContent,
        })),
        numbers: [
          ...document.querySelectorAll(
            ".diff-line-addition .diff-line-num:nth-child(2)",
          ),
        ].map((cell) => cell.textContent.trim()),
      }));
      assert(
        layout.table.right <= layout.viewport + 1,
        `Table overflow in variant ${variant} at ${width}px`,
      );
      assert.equal(layout.cells.length, 2);
      assert.deepEqual(layout.numbers, ["1", "2"]);
      assert.equal(layout.cells[0].text, `    ${prose}`);
      assert.equal(layout.cells[1].text, token);
      for (const cell of layout.cells) {
        assert(
          cell.scrollWidth <= cell.width + 1,
          `Clipped cell in variant ${variant} at ${width}px`,
        );
        assert(
          cell.height > cell.lineHeight * 2,
          "Long lines must actually wrap",
        );
        assert.equal(cell.whiteSpace, "pre-wrap");
      }
    }
  }
});

test("comments on wrapped lines retain their original line number", async (t) => {
  const browser = await chromium.launch({
    channel: process.env.DIFFF_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  t.after(() => browser.close());
  const provider = createWebviewProvider();
  const content = `diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+first\n+${"long line ".repeat(50)}\n`;
  const files = [{ path: "new.txt", content, additions: 2, deletions: 0 }];
  for (const html of [
    provider.getAllDiffsContent(files),
    provider.getWorkingDirectoryContent(files),
  ]) {
    const page = await browser.newPage({
      viewport: { width: 640, height: 900 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent(
      html.replace(
        "<head>",
        "<head><script>window.messages = []; window.acquireVsCodeApi = () => ({ postMessage(message) { window.messages.push(message); }, getState() {}, setState() {} });</script>",
      ),
    );
    await page.locator('.add-comment-button[data-line-number="2"]').click();
    await page.locator(".comment-textarea").fill("Comment on the wrapped line");
    await page.locator("[data-submit-comment]").click();
    assert.deepEqual(
      await page.evaluate(() =>
        window.messages.find((message) => message.command === "addComment"),
      ),
      {
        command: "addComment",
        filePath: "new.txt",
        lineNumber: 2,
        lineType: "addition",
        content: "Comment on the wrapped line",
      },
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
});
