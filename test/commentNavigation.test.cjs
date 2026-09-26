const assert = require("node:assert/strict");
const { test } = require("node:test");
const Module = require("node:module");

const comment = {
  id: "comment-a",
  filePath: "src/file.ts",
  lineNumber: 1,
  lineType: "addition",
  content: "Review A",
  author: "Reviewer",
  timestamp: 1,
  baseRef: "main",
  compareRef: "feature-a",
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function activateExtension(t, getDiffFiles) {
  const commands = new Map();
  const providers = new Map();
  const panels = [];
  const errors = [];
  const gitCalls = [];
  const stored = new Map([["difff.comments", [comment]]]);
  const files = [{ path: comment.filePath, additions: 1, deletions: 0 }];
  const diff = "@@ -0,0 +1 @@\n+new line\n";
  let clipboard;
  const disposable = () => ({ dispose() {} });
  const vscode = {
    TreeItem: class {},
    EventEmitter: class {
      event = disposable;
      fire() {}
    },
    ViewColumn: { One: 1 },
    ProgressLocation: { Notification: 15 },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
      getConfiguration: () => ({ get: () => "Reviewer" }),
    },
    env: {
      clipboard: {
        writeText: async (value) => {
          clipboard = value;
        },
      },
    },
    commands: {
      registerCommand(name, callback) {
        commands.set(name, callback);
        return disposable();
      },
      executeCommand(name, ...args) {
        return commands.get(name)(...args);
      },
    },
    window: {
      registerTreeDataProvider(name, provider) {
        providers.set(name, provider);
        return disposable();
      },
      showErrorMessage: (message) => errors.push(message),
      showInformationMessage() {},
      withProgress: (_, callback) => callback({ report() {} }),
      createWebviewPanel(_, title, viewColumn) {
        const disposeHandlers = [];
        const stateHandlers = [];
        let receive;
        let html = "";
        const panel = {
          title,
          viewColumn,
          visible: true,
          disposed: false,
          reveals: [],
          htmlWrites: 0,
          messages: [],
          webview: {
            get html() {
              return html;
            },
            set html(value) {
              if (html === value) return;
              html = value;
              panel.htmlWrites++;
            },
            onDidReceiveMessage(callback) {
              receive = callback;
              return disposable();
            },
            postMessage(message) {
              panel.messages.push(message);
              return Promise.resolve(true);
            },
          },
          onDidDispose(callback) {
            disposeHandlers.push(callback);
            return disposable();
          },
          onDidChangeViewState(callback) {
            stateHandlers.push(callback);
            return disposable();
          },
          reveal(column) {
            panel.reveals.push(column);
            panel.visible = true;
            stateHandlers.forEach((callback) =>
              callback({ webviewPanel: panel }),
            );
          },
          dispose() {
            if (panel.disposed) return;
            panel.disposed = true;
            disposeHandlers.forEach((callback) => callback());
          },
          receive(message) {
            return receive(message);
          },
        };
        panels.push(panel);
        return panel;
      },
    },
  };
  class GitService {
    async getDiffFiles(base, compare) {
      gitCalls.push([base, compare]);
      if (getDiffFiles) await getDiffFiles(base, compare);
      return files;
    }
    async getFileDiff() {
      return diff;
    }
    async getWorkingDirectoryFiles() {
      return files;
    }
    async getWorkingDirectoryFileDiff() {
      return diff;
    }
    async getCurrentCommitHash() {
      return "current-commit";
    }
  }
  const originalLoad = Module._load;
  // Each harness gets real extension/providers/services with a fresh VS Code host.
  for (const name of [
    "extension",
    "diffExplorer",
    "commentExplorer",
    "commentService",
    "commentTemplateProvider",
    "webviewProvider",
  ]) {
    delete require.cache[require.resolve(`../out/${name}`)];
  }
  Module._load = function (id, ...args) {
    if (id === "vscode") return vscode;
    if (id === "./gitService") return { GitService };
    return originalLoad.call(this, id, ...args);
  };
  try {
    require("../out/extension").activate({
      extensionUri: {},
      subscriptions: [],
      globalState: {
        get: (key) => stored.get(key),
        update: async (key, value) => {
          stored.set(key, value);
        },
      },
    });
  } finally {
    Module._load = originalLoad;
  }
  t.after(() => assert.deepEqual(errors, []));
  return {
    panels,
    gitCalls,
    stored,
    errors,
    execute: vscode.commands.executeCommand,
    explorer: providers.get("difff.explorer"),
    clipboard: () => clipboard,
  };
}

test("comment clicks reuse an existing comparison tab and queue navigation until ready", async (t) => {
  const app = activateExtension(t);
  await app.explorer.setRefs("main", "feature-a");
  await app.execute("difff.viewDiff");
  const panel = app.panels[0];
  panel.visible = false;
  panel.viewColumn = 2;
  await app.execute("difff.jumpToComment", comment);
  assert.equal(app.panels.length, 1);
  assert.deepEqual(panel.reveals, [2]);
  assert.deepEqual(
    panel.messages,
    [],
    "Wait for the webview before navigating",
  );
  await panel.receive({ command: "webviewReady" });
  assert.deepEqual(panel.messages.pop(), {
    command: "revealComment",
    commentId: comment.id,
  });
  await panel.receive({ command: "commentRevealed", commentId: comment.id });
  await panel.receive({ command: "webviewReady" });
  assert.equal(panel.messages.length, 0, "Acknowledged jumps are not replayed");
  await app.execute("difff.jumpToComment", comment);
  assert.deepEqual(panel.messages.pop(), {
    command: "revealComment",
    commentId: comment.id,
  });
  assert.equal(
    panel.htmlWrites,
    1,
    "Reusing the tab preserves its content and state",
  );
  panel.messages.length = 0;
  await app.execute("difff.viewDiff");
  await app.execute("difff.jumpToComment", comment);
  assert.deepEqual(
    panel.messages.pop(),
    { command: "revealComment", commentId: comment.id },
    "Unchanged refreshes keep the webview ready",
  );
  panel.dispose();
  await app.execute("difff.jumpToComment", comment);
  assert.equal(
    app.panels.length,
    2,
    "Closing the tab allows a new one to open",
  );
});

test("rapid clicks share a loading tab and navigate to the latest comment", async (t) => {
  const gate = deferred();
  const started = deferred();
  const app = activateExtension(t, () => {
    started.resolve();
    return gate.promise;
  });
  const first = app.execute("difff.jumpToComment", comment);
  await started.promise;
  await app.execute("difff.jumpToComment", { ...comment, id: "comment-b" });
  assert.equal(app.panels.length, 1);
  gate.resolve();
  await first;
  await app.panels[0].receive({ command: "webviewReady" });
  assert.deepEqual(app.panels[0].messages.pop(), {
    command: "revealComment",
    commentId: "comment-b",
  });
});

test("open comparisons retain their refs for refresh, copy and comment creation", async (t) => {
  const app = activateExtension(t);
  await app.execute("difff.jumpToComment", comment);
  await app.execute("difff.jumpToComment", {
    ...comment,
    id: "comment-b",
    compareRef: "feature-b",
  });
  assert.equal(app.panels.length, 2);
  const panel = app.panels[0];
  await panel.receive({ command: "reload" });
  assert.deepEqual(app.gitCalls.at(-1), ["main", "feature-a"]);
  assert(panel.webview.html.includes("feature-a"));
  assert(!panel.webview.html.includes("feature-b"));
  await panel.receive({ command: "copyComments" });
  assert(app.clipboard().includes("Review A"));
  await panel.receive({
    command: "addComment",
    filePath: comment.filePath,
    lineNumber: 1,
    lineType: "addition",
    content: "New A",
  });
  const added = app.stored.get("difff.comments").at(-1);
  assert.equal(added.baseRef, "main");
  assert.equal(added.compareRef, "feature-a");
  await app.execute("difff.jumpToComment", comment);
  assert.equal(app.panels.length, 2);
});

test("working-directory comments reuse the working tab and wait through a reload", async (t) => {
  const app = activateExtension(t);
  app.explorer.setMode("working");
  await app.execute("difff.viewDiff");
  const panel = app.panels[0];
  await panel.receive({ command: "webviewReady" });
  app.stored.set("difff.comments", [
    { ...comment, baseRef: "current-commit", compareRef: "working" },
  ]);
  await panel.receive({ command: "reload" });
  panel.messages.length = 0;
  await app.execute("difff.jumpToComment", {
    ...comment,
    baseRef: "current-commit",
    compareRef: "working",
  });
  assert.equal(app.panels.length, 1);
  assert.equal(panel.messages.length, 0);
  await panel.receive({ command: "webviewReady" });
  assert.deepEqual(panel.messages.pop(), {
    command: "revealComment",
    commentId: comment.id,
  });
});

test("closing a loading tab does not overwrite its replacement", async (t) => {
  const gate = deferred();
  const started = deferred();
  let first = true;
  const app = activateExtension(t, () => {
    if (!first) return;
    first = false;
    started.resolve();
    return gate.promise;
  });
  const opening = app.execute("difff.jumpToComment", comment);
  await started.promise;
  app.panels[0].dispose();
  await app.execute("difff.jumpToComment", comment);
  gate.resolve();
  await opening;
  assert.equal(app.panels[0].htmlWrites, 0);
  await app.execute("difff.jumpToComment", comment);
  assert.equal(app.panels.length, 2);
});
