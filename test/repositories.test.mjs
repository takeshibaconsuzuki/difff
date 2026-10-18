import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['vscode', 'simple-git', './git'], logLevel: 'silent',
});

function reviewHost({ platform, workspaceRoots, gitRoots, comments = [], gitDisabled = false, groupCount = 1 }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const uri = fsPath => ({ scheme: 'file', fsPath, toString: () => fsPath });
  const disposable = { dispose() {} };
  const storage = new Map([['difff.comments.v1', comments]]);
  const messages = [];
  const commands = [];
  const groups = Array.from({ length: groupCount }, () => ({}));
  const layout = { orientation: 0, groups: groups.map(() => ({ size: 300 })) };
  let receive;
  let open;
  let copied;
  let done;
  let windowStateChanged;
  const vscode = {
    Uri: { joinPath: (base, ...parts) => uri(paths.join(base.fsPath, ...parts)) },
    ThemeIcon: class {},
    ViewColumn: { Active: 1 },
    workspace: { workspaceFolders: workspaceRoots.map(root => ({ uri: uri(root) })) },
    extensions: { getExtension: () => gitDisabled ? undefined : {
      activate: async () => ({ getAPI: () => ({ repositories: gitRoots.map(root => ({ rootUri: uri(root) })) }) }),
    } },
    commands: {
      registerCommand: (_name, callback) => { open = callback; return disposable; },
      executeCommand: async (name, ...args) => { commands.push({ name, args }); if (name === 'vscode.getEditorLayout') return layout; },
    },
    env: { clipboard: { writeText: async text => { copied = text; } } },
    window: { onDidChangeWindowState: callback => { windowStateChanged = callback; return disposable; }, tabGroups: { all: groups, onDidChangeTabGroups: () => disposable }, createWebviewPanel: () => ({
      active: true,
      webview: {
        asWebviewUri: value => value,
        onDidReceiveMessage: callback => { receive = callback; return disposable; },
        postMessage: message => {
          messages.push(structuredClone(message));
          if (message.type === 'busy' && !message.busy) done();
        },
      },
      onDidDispose: () => disposable,
      onDidChangeViewState: () => disposable,
    }) },
  };
  const module = { exports: {} };
  runInNewContext(outputFiles[0].text, {
    module, process: { platform },
    require: name => {
      if (name === 'vscode') return vscode;
      if (name === 'node:path') return paths;
      // Git's root spelling deliberately differs from VS Code's on Windows.
      if (name === 'simple-git') return { simpleGit: root => ({ revparse: async () => root }) };
      if (name === './git') return { GitReview: class {
        async files() { return []; }
        async branch() { return 'main'; }
      } };
      return require(name);
    },
  });
  module.exports.activate({
    subscriptions: [], extensionUri: uri(workspaceRoots[0]),
    workspaceState: { get: key => storage.get(key), update: async (key, value) => { storage.set(key, value); } },
  });
  open();
  return {
    async send(message) {
      await new Promise(resolve => { done = resolve; receive(message); });
      assert.ok(!messages.some(message => message.type === 'notice' && message.error), 'Host messages should succeed');
    },
    get state() { return messages.findLast(message => message.type === 'state')?.state; },
    get copied() { return copied; },
    get comments() { return storage.get('difff.comments.v1'); },
    get commands() { return commands; },
    get layout() { return layout; },
    get groups() { return groups; },
    async loseWindowFocus() { await new Promise(resolve => { done = resolve; windowStateChanged({ focused: false }); }); },
  };
}

test('losing application focus restores the saved split once and never remaximizes on repeated blur', async () => {
  const host = reviewHost({ platform: 'linux', workspaceRoots: ['/work'], gitRoots: ['/work'], groupCount: 2 });
  await host.send({ type: 'maximize' });
  await host.loseWindowFocus();
  assert.deepEqual(host.commands.map(command => command.name), ['vscode.getEditorLayout', 'workbench.action.toggleMaximizeEditorGroup', 'vscode.setEditorLayout']);
  assert.deepEqual(host.commands.at(-1).args, [host.layout]);
  await host.send({ type: 'blur' });
  await host.loseWindowFocus();
  assert.equal(host.commands.length, 3);

  await host.send({ type: 'maximize' });
  host.groups.push({});
  await host.send({ type: 'blur' });
  assert.equal(host.commands.at(-1).name, 'workbench.action.toggleMaximizeEditorGroup', 'Restoring must not remove a newly created group');
});

test('Windows root defaults retain saved repository identities and comment actions', async () => {
  const root = 'e:\\Devel\\difff';
  const submodule = `${root}\\lib`;
  const saved = {
    id: 'saved-comment', repository: root, path: 'review.txt', line: 1, side: 'new', code: 'working contents',
    baseRef: 'HEAD', endRef: 'WORKING', body: 'Previously saved comment', createdAt: '2026-01-01',
  };
  const host = reviewHost({
    platform: 'win32', workspaceRoots: ['E:/Devel/difff'], gitRoots: [submodule, root], comments: [saved],
  });
  await host.send({ type: 'ready' });
  assert.equal(host.state.repository, root);
  assert.deepEqual(host.state.repositories.map(repo => repo.root), [root, submodule]);
  assert.deepEqual(host.state.comments, [saved]);

  await host.send({ type: 'edit', id: saved.id, body: 'Edited saved comment' });
  assert.equal(host.comments[0].repository, root);
  assert.equal(host.state.comments[0].body, 'Edited saved comment');
  await host.send({ type: 'copy' });
  assert.equal(host.copied, 'review.txt:1\nEdited saved comment');

  await host.send({ type: 'repository', root: submodule });
  await host.send({ type: 'refresh' });
  assert.equal(host.state.repository, submodule);
  assert.deepEqual(host.state.comments, []);
  await host.send({ type: 'ready', repository: root });
  assert.equal(host.state.repository, root);
  assert.equal(host.state.comments[0].body, 'Edited saved comment');
});

test('workspace order takes precedence over discovery order without dropping submodules', async () => {
  const host = reviewHost({
    platform: 'linux', workspaceRoots: ['/work/first', '/work/second'],
    gitRoots: ['/work/second/lib', '/work/second', '/work/first/lib', '/work/first'],
  });
  await host.send({ type: 'ready' });
  assert.equal(host.state.repository, '/work/first');
  assert.deepEqual(host.state.repositories.map(repo => repo.root), ['/work/first', '/work/second', '/work/second/lib', '/work/first/lib']);
});

test('workspace probing still works when the Git extension is disabled', async () => {
  const host = reviewHost({ platform: 'win32', workspaceRoots: ['E:/Devel/difff'], gitDisabled: true });
  await host.send({ type: 'ready' });
  assert.equal(host.state.repository, 'E:\\Devel\\difff');
  assert.equal(host.state.repositories.length, 1);
});


test('comparison defaults and comment jumps retain both endpoints', async () => {
  const root = '/work/review';
  const saved = { id: 'ref-comment', repository: root, path: 'review.txt', line: 1, side: 'new', code: 'text', baseRef: 'abc1234', endRef: 'def5678', body: 'Review these commits', createdAt: '2026-01-01' };
  const host = reviewHost({ platform: 'linux', workspaceRoots: [root], gitRoots: [root], comments: [saved] });
  await host.send({ type: 'ready' });
  assert.equal(host.state.baseRef, 'HEAD');
  assert.equal(host.state.endRef, 'WORKING');
  await host.send({ type: 'jump', id: saved.id });
  assert.equal(host.state.baseRef, saved.baseRef);
  assert.equal(host.state.endRef, saved.endRef);
  await host.send({ type: 'comparison', baseRef: saved.baseRef, endRef: 'HEAD' });
  await host.send({ type: 'jump', id: saved.id });
  assert.equal(host.state.endRef, saved.endRef);

});
