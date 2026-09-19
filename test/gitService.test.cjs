const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createGitService, createWebviewProvider } = require("./helpers.cjs");

async function repository(t, commit = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "difff-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
  git("init", "--quiet");
  git("config", "core.autocrlf", "false");
  git("config", "core.hooksPath", path.join(root, ".git", "no-hooks"));
  async function write(name, content) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  if (commit) {
    await write("tracked.txt", "original\n");
    git("add", "--", "tracked.txt");
    git(
      "-c",
      "user.name=Difff Tests",
      "-c",
      "user.email=difff@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Initial",
    );
  }
  return { root, git, write, service: createGitService(root) };
}

test("untracked text, nested paths, Unicode and literal filenames show additions without touching the index", async (t) => {
  const { root, git, write, service } = await repository(t);
  const inputs = new Map([
    ["new.txt", "first\nsecond\n"],
    ["new folder/deeper/日本語 [draft].md", "nested\n"],
    ["file with spaces.txt", "spaces\n"],
    ["special[1].txt", "literal\n"],
    ["special1.txt", "different\n"],
    ["--option.txt", "option\n"],
    ["no-final-newline.txt", "last line"],
    ["crlf.txt", "one\r\ntwo\r\n"],
    ["prefixes.txt", "++source\n--source\n\n"],
  ]);
  await write(".gitignore", "ignored/\n");
  await write("ignored/secret.txt", "ignored\n");
  for (const [name, content] of inputs) {
    await write(name, content);
  }
  const beforeIndex = await fs.readFile(path.join(root, ".git", "index"));
  const beforeStatus = git(
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  );
  const files = await service.getWorkingDirectoryFiles();
  assert(!files.some((file) => file.path.startsWith("ignored/")));
  for (const [name, content] of inputs) {
    const lines = content.replace(/\n$/, "").split("\n");
    const file = files.find((file) => file.path === name);
    assert.deepEqual(file, {
      path: name,
      status: "untracked",
      additions: lines.length,
      deletions: 0,
    });
    const diff = await service.getWorkingDirectoryFileDiff(name);
    for (const line of lines) {
      assert(diff.includes(`+${line}`), `Missing content for ${name}`);
    }
    const html = createWebviewProvider().getWorkingDirectoryContent([
      { ...file, content: diff },
    ]);
    assert.equal(
      (html.match(/<tr class="diff-line diff-line-addition"/g) || []).length,
      lines.length,
    );
    assert(
      !html.includes('class="diff-line diff-line-context"'),
      "No phantom line after a trailing newline",
    );
    assert(!html.includes("No changes in this file"));
  }
  assert.match(
    await service.getWorkingDirectoryFileDiff("no-final-newline.txt"),
    /\\ No newline at end of file/,
  );
  assert.deepEqual(
    await fs.readFile(path.join(root, ".git", "index")),
    beforeIndex,
  );
  assert.equal(
    git("status", "--porcelain=v1", "-z", "--untracked-files=all"),
    beforeStatus,
  );
});

test("empty and binary untracked files have accurate messages", async (t) => {
  const { write, service } = await repository(t);
  await write("empty.txt", "");
  await write("binary.bin", Buffer.from([0, 1, 2, 3, 255]));
  const files = await service.getWorkingDirectoryFiles();
  for (const [name, message] of [
    ["empty.txt", "New empty file"],
    ["binary.bin", "Binary file contents are not displayed"],
  ]) {
    const file = files.find((file) => file.path === name);
    assert.equal(file.additions, 0);
    assert.equal(file.deletions, 0);
    const content = await service.getWorkingDirectoryFileDiff(name);
    const provider = createWebviewProvider();
    for (const html of [
      provider.getWorkingDirectoryContent([{ ...file, content }]),
      provider.getWebviewContent(content, name),
    ]) {
      assert(html.includes(message));
      assert(!html.includes("No changes in this file"));
    }
  }
});

test("untracked files work before the first commit", async (t) => {
  const { write, service, git } = await repository(t, false);
  await write("new/nested.txt", "new content\n");
  assert.equal((await service.getWorkingDirectoryFiles())[0].additions, 1);
  assert.match(await service.getWorkingDirectoryDiff(), /\+new content/);
  assert.equal(git("ls-files", "--stage"), "");
});

test("nested workspaces resolve repository-relative paths", async (t) => {
  const { root, write } = await repository(t);
  await write("subdir/new.txt", "nested workspace\n");
  const service = createGitService(path.join(root, "subdir"));
  assert.equal(
    (await service.getWorkingDirectoryFiles())[0].path,
    "subdir/new.txt",
  );
  assert.match(
    await service.getWorkingDirectoryFileDiff("subdir/new.txt"),
    /\+nested workspace/,
  );
});

test("staged and unstaged changes still render, including renamed paths", async (t) => {
  const { git, write, service } = await repository(t);
  await write("tracked.txt", "staged\n");
  git("add", "--", "tracked.txt");
  await write("tracked.txt", "unstaged\n");
  const diff = await service.getWorkingDirectoryFileDiff("tracked.txt");
  assert.match(diff, /\+staged/);
  assert.match(diff, /\+unstaged/);
  const file = (await service.getWorkingDirectoryFiles())[0];
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 2);
  const html = createWebviewProvider().getWorkingDirectoryContent([
    { ...file, content: diff },
  ]);
  assert.equal(
    (html.match(/<tr class="diff-line diff-line-addition"/g) || []).length,
    2,
  );
  git("mv", "--", "tracked.txt", "renamed file.txt");
  assert(
    (await service.getWorkingDirectoryFiles()).some(
      (entry) => entry.path === "renamed file.txt",
    ),
  );
});
