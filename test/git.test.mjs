import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { lstat, mkdtemp, mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { simpleGit } from 'simple-git';

await build({ entryPoints: ['src/git.ts', 'src/git-renames.ts', 'src/model.ts', 'src/validation.ts'], outdir: '.tools/tests', bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const require = createRequire(import.meta.url);
const { GitReview } = require('../.tools/tests/git.js');
const { withUntrackedComparison } = require('../.tools/tests/git-renames.js');
const { findAnchor, formatComments } = require('../.tools/tests/model.js');
const { messageSchema } = require('../.tools/tests/validation.js');
const temporary = [];
after(async () => { for (const directory of temporary) await rm(directory, { recursive: true, force: true }); });
async function repository() {
  const directory = await mkdtemp(path.join(tmpdir(), 'difff-test-'));
  temporary.push(directory);
  const git = simpleGit(directory);
  await git.init();
  await git.addConfig('user.name', 'Diff Test');
  await git.addConfig('user.email', 'diff@example.test');
  await git.addConfig('core.autocrlf', 'false');
  return { directory, git, review: new GitReview(directory) };
}

test('Git scopes separate HEAD, index, and worktree; preserve literal paths and line anchors', async () => {
  const { directory, git, review } = await repository();
  await mkdir(path.join(directory, 'src'));
  const filename = 'src/review [v1] ü.ts';
  const original = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  await writeFile(path.join(directory, filename), original);
  await writeFile(path.join(directory, 'deleted.txt'), 'original\n');
  await git.add('.');
  await git.commit('initial');
  const staged = original.replace('line 20\n', 'staged change\n');
  await writeFile(path.join(directory, filename), staged);
  await git.add(filename);
  await git.rm('deleted.txt');
  await writeFile(path.join(directory, filename), staged.replace('line 60\n', 'unstaged change\n'));
  await writeFile(path.join(directory, 'new file.txt'), 'brand new\nsecond line');
  await writeFile(path.join(directory, 'binary.dat'), Buffer.from([1, 0, 3]));
  const stagedFiles = await review.files('staged');
  const unstagedFiles = await review.files('unstaged');
  const allFiles = await review.files('uncommitted');
  const find = files => files.find(file => file.path === filename);
  const additions = file => file.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind === 'add');
  assert.deepEqual(additions(find(stagedFiles)).map(line => line.text), ['staged change']);
  assert.deepEqual(additions(find(unstagedFiles)).map(line => line.text), ['unstaged change']);
  assert.deepEqual(additions(find(allFiles)).map(line => line.text), ['staged change', 'unstaged change']);
  assert.equal(additions(find(stagedFiles))[0].newLine, 20);
  assert.equal(stagedFiles.some(file => file.path === 'new file.txt'), false);
  assert.equal(allFiles.find(file => file.path === 'new file.txt').additions, 2);
  assert.match(allFiles.find(file => file.path === 'binary.dat').notice, /Binary/);
  assert.equal(stagedFiles.find(file => file.path === 'deleted.txt').status, 'D');
  assert.equal(unstagedFiles.some(file => file.path === 'deleted.txt'), false);
  const expanded = review.expandAll(find(allFiles));
  assert.equal(expanded.hunks.length, 1);
  assert.equal(expanded.hunks[0].lines[0].oldLine, 1);
  assert.equal(expanded.hunks[0].lines.at(-1).newLine, 80);
  assert.throws(() => review.resolve('../outside.txt'), /Invalid/);
});

test('blank context keeps its line anchors and expands when Git suppresses blank prefixes', async () => {
  const { directory, git, review } = await repository();
  const filename = 'blank-lines.txt';
  const original = Array.from({ length: 20 }, (_, index) => index === 8 || index === 10 ? '' : `line ${index + 1}`).join('\n') + '\n';
  await writeFile(path.join(directory, filename), original);
  await git.add('.');
  await git.commit('initial');
  await git.addConfig('diff.suppressBlankEmpty', 'true');
  await writeFile(path.join(directory, filename), original.replace('line 10\n', 'changed\n'));

  for (const scenario of ['unstaged', 'uncommitted', 'staged', 'recreated']) {
    if (scenario === 'staged') await git.add(filename);
    if (scenario === 'recreated') await git.raw(['rm', '--cached', '--', filename]);
    const [file] = await review.files(scenario === 'recreated' ? 'uncommitted' : scenario);
    const lines = file.hunks.flatMap(hunk => hunk.lines);
    assert.deepEqual(lines.filter(line => line.kind !== 'context'), [
      { kind: 'delete', text: 'line 10', oldLine: 10 },
      { kind: 'add', text: 'changed', newLine: 10 },
    ], scenario);
    assert.deepEqual(lines.filter(line => line.text === ''), [
      { kind: 'context', text: '', oldLine: 9, newLine: 9 },
      { kind: 'context', text: '', oldLine: 11, newLine: 11 },
    ], scenario);
    assert.equal(file.notice, undefined, scenario);
    assert.ok(file.gaps.length > 0, scenario);
    const expanded = review.expandAll(file);
    assert.deepEqual(expanded.gaps, [], scenario);
    const expandedLines = expanded.hunks.flatMap(hunk => hunk.lines);
    const expectedNumbers = Array.from({ length: 20 }, (_, index) => index + 1);
    assert.deepEqual(expandedLines.filter(line => line.oldLine).map(line => line.oldLine), expectedNumbers, scenario);
    assert.deepEqual(expandedLines.filter(line => line.newLine).map(line => line.newLine), expectedNumbers, scenario);
  }
  assert.equal((await git.raw(['config', '--get', 'diff.suppressBlankEmpty'])).trim(), 'true');
});

test('context expands only the selected gap and direction, removes exhausted gaps, and preserves line numbers', async () => {
  const { directory, git, review } = await repository();
  const original = Array.from({ length: 160 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  await writeFile(path.join(directory, 'eslint.config.mjs'), original);
  await git.add('.');
  await git.commit('initial');
  await writeFile(path.join(directory, 'eslint.config.mjs'), original.replace('line 5\n', 'first change\n').replace('line 80\n', 'second change\nextra line\n'));
  const [file] = await review.files('unstaged');
  assert.equal(file.hunks[0].oldStart, 2);
  assert.deepEqual(file.gaps.map(gap => gap.count), [1, 68, 77]);
  const middle = file.gaps[1];
  const expandedDown = review.expand(file, middle.id, 'down');
  assert.equal(expandedDown.hunks[0].oldStart, 2, 'Expanding below must not reveal line 1 above');
  assert.equal(expandedDown.hunks[0].lines.at(-1).oldLine, 28);
  assert.deepEqual(expandedDown.hunks[1], file.hunks[1], 'The next hunk must not expand too');
  const expandedUp = review.expand(file, middle.id, 'up');
  assert.deepEqual(expandedUp.hunks[0], file.hunks[0]);
  assert.equal(expandedUp.hunks[1].oldStart, 57);
  const bottom = review.expand(file, file.gaps[2].id, 'down');
  assert.equal(bottom.hunks[0].oldStart, 2);
  assert.equal(bottom.hunks[1].lines.at(-1).oldLine, 103);
  assert.equal(bottom.hunks[1].lines.at(-1).newLine, 104);
  const top = review.expand(bottom, bottom.gaps[0].id, 'up');
  assert.equal(top.hunks[0].oldStart, 1);
  assert.equal(top.gaps.some(gap => gap.before === 0), false, 'No control remains above line 1');
  assert.equal(review.expand(top, file.gaps[0].id, 'up'), top, 'A stale gap request cannot expand a different region');
  // Context belongs to the review snapshot, even if the index changes after loading.
  await git.add('.');
  const full = review.expandAll(top);
  assert.equal(full.gaps.length, 0);
  assert.equal(full.hunks.length, 1);
  assert.equal(full.hunks[0].oldLines, 160);
  assert.equal(full.hunks[0].newLines, 161);
  assert.deepEqual(full.hunks[0].lines.filter(line => line.oldLine).map(line => line.oldLine), Array.from({ length: 160 }, (_, i) => i + 1));
  assert.deepEqual(full.hunks[0].lines.filter(line => line.newLine).map(line => line.newLine), Array.from({ length: 161 }, (_, i) => i + 1));
  assert.equal(full.additions, file.additions);
  assert.equal(full.deletions, file.deletions);
  const revealed = review.reveal(file, 'new', 130);
  assert.ok(revealed.hunks.some(hunk => hunk.lines.some(line => line.newLine === 130 && line.oldLine === 129)));
});

test('context expansion handles CRLF, beginning insertions, and end deletions', async () => {
  const { directory, git, review } = await repository();
  const original = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\r\n') + '\r\n';
  await writeFile(path.join(directory, 'edges.txt'), original);
  await git.add('.');
  await git.commit('initial');
  await writeFile(path.join(directory, 'edges.txt'), `new first\r\nnew second\r\n${original.replace('line 40\r\n', '')}`);
  const [file] = await review.files('uncommitted');
  assert.equal(file.gaps.length, 1);
  assert.equal(file.gaps[0].before, 1);
  const full = review.expandAll(file);
  assert.equal(full.hunks[0].oldStart, 1);
  assert.equal(full.hunks[0].newStart, 1);
  assert.equal(full.hunks[0].oldLines, 40);
  assert.equal(full.hunks[0].newLines, 41);
  assert.equal(full.gaps.length, 0);
  assert.equal(full.hunks[0].lines.some(line => line.text.endsWith('\r')), false);
});

test('Expand all reveals more than 10,000 hidden lines in one operation', async () => {
  const { directory, git, review } = await repository();
  const original = Array.from({ length: 12000 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
  await writeFile(path.join(directory, 'large.txt'), original);
  await git.add('.');
  await git.commit('initial');
  await writeFile(path.join(directory, 'large.txt'), original.replace('line 6000\n', 'changed\n'));
  const [file] = await review.files('unstaged');
  const expanded = review.expandAll(file);
  assert.equal(expanded.gaps.length, 0);
  assert.equal(expanded.hunks.length, 1);
  assert.equal(expanded.hunks[0].oldStart, 1);
  assert.equal(expanded.hunks[0].oldLines, 12000);
  assert.equal(expanded.hunks[0].newLines, 12000);
  assert.equal(expanded.hunks[0].lines.at(-1).newLine, 12000);
});

test('unborn repositories include staged and untracked changes without HEAD', { timeout: 10000 }, async () => {
  const { directory, git, review } = await repository();
  await writeFile(path.join(directory, 'new.txt'), 'index\n');
  await git.add('.');
  await writeFile(path.join(directory, 'new.txt'), 'working\n');
  await writeFile(path.join(directory, 'untracked.txt'), 'other\n');
  const staged = await review.files('staged');
  const unstaged = await review.files('unstaged');
  const all = await review.files('uncommitted');
  assert.equal(staged.length, 1);
  assert.equal(staged[0].hunks[0].lines[0].text, 'index');
  assert.equal(unstaged.length, 2);
  assert.equal(all.length, 2);
  assert.equal(all.find(file => file.path === 'new.txt').hunks[0].lines[0].text, 'working');
});

test('net-zero changes are omitted, renames remain reviewable, and ignored files stay out', async () => {
  const { directory, git, review } = await repository();
  await writeFile(path.join(directory, 'a.txt'), 'base\n');
  await writeFile(path.join(directory, 'rename.txt'), 'renamed content\n');
  await writeFile(path.join(directory, '.gitignore'), '*.secret\n');
  await git.add('.');
  await git.commit('initial');
  await writeFile(path.join(directory, 'a.txt'), 'index\n');
  await git.add('a.txt');
  await writeFile(path.join(directory, 'a.txt'), 'base\n');
  await git.mv('rename.txt', 'renamed.txt');
  await writeFile(path.join(directory, 'ignored.secret'), 'private\n');
  const all = await review.files('uncommitted');
  assert.equal(all.some(file => file.path === 'a.txt'), false);
  assert.equal(all.some(file => file.path === 'ignored.secret'), false);
  assert.equal(all.length, 1);
  assert.equal(all[0].path, 'renamed.txt');
  assert.equal(all[0].originalPath, 'rename.txt');
  assert.equal(all[0].status, 'R');
  assert.equal(all[0].additions, 0);
  assert.equal(all[0].deletions, 0);
  assert.deepEqual(all[0].hunks, []);
  assert.equal(all[0].notice, 'File renamed without text changes.');
  const [staged] = (await review.files('staged')).filter(file => file.status === 'R');
  assert.equal(staged.originalPath, 'rename.txt');
  assert.equal(staged.path, 'renamed.txt');
  assert.equal(staged.notice, all[0].notice);
});

test('renames preserve both literal paths, scope contents, and expandable source context', async () => {
  const { directory, git, review } = await repository();
  const originalPath = 'src/original [v1] ü.ts';
  const destination = 'renamed [v2] 日本.ts';
  const original = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  await mkdir(path.join(directory, 'src'));
  await writeFile(path.join(directory, originalPath), original);
  await writeFile(path.join(directory, 'deleted.txt'), 'remove me\n');
  await writeFile(path.join(directory, 'modified.txt'), 'before\n');
  await git.add('.');
  await git.commit('initial');
  await git.addConfig('diff.renames', 'false');
  await git.addConfig('diff.noprefix', 'true');
  await git.mv(originalPath, destination);
  const staged = original.replace('line 20\n', 'staged change\n');
  await writeFile(path.join(directory, destination), staged);
  await writeFile(path.join(directory, 'added.txt'), 'new file\n');
  await writeFile(path.join(directory, 'modified.txt'), 'after\n');
  await git.rm('deleted.txt');
  await git.add('.');
  await writeFile(path.join(directory, destination), staged.replace('line 60\n', 'unstaged change\n'));

  for (const scope of ['staged', 'uncommitted', 'unstaged']) {
    const files = await review.files(scope);
    const file = files.find(file => file.path === destination);
    assert.ok(file, scope);
    assert.equal(file.status, scope === 'unstaged' ? 'M' : 'R');
    assert.equal(file.originalPath, scope === 'unstaged' ? undefined : originalPath);
    assert.equal(file.notice, undefined, scope);
    const additions = file.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind === 'add');
    assert.deepEqual(additions.map(line => line.text), scope === 'staged' ? ['staged change'] : scope === 'unstaged' ? ['unstaged change'] : ['staged change', 'unstaged change']);
    assert.equal(file.additions, additions.length);
    assert.equal(file.deletions, additions.length);
    const expanded = review.expandAll(file);
    assert.deepEqual(expanded.gaps, []);
    assert.equal(expanded.hunks[0].lines[0].oldLine, 1);
    assert.equal(expanded.hunks[0].lines.at(-1).newLine, 80);
    assert.ok(review.reveal(file, 'old', 40).hunks.some(hunk => hunk.lines.some(line => line.oldLine === 40 && line.text === 'line 40')));
    if (scope !== 'unstaged') {
      assert.deepEqual(files.filter(file => file.path !== destination).map(file => [file.path, file.status]), [['added.txt', 'A'], ['deleted.txt', 'D'], ['modified.txt', 'M']]);
    } else assert.equal(files.length, 1);
  }
});

test('unstaged renames use the index source with an untracked or intent-to-add destination', async () => {
  const { directory, git, review } = await repository();
  const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  await writeFile(path.join(directory, 'old.txt'), original);
  await git.add('.');
  await git.commit('initial');
  const indexed = original.replace('line 10\n', 'indexed line\n');
  await writeFile(path.join(directory, 'old.txt'), indexed);
  await git.add('old.txt');
  await rename(path.join(directory, 'old.txt'), path.join(directory, 'new.txt'));
  await writeFile(path.join(directory, 'new.txt'), indexed.replace('line 20\n', 'working line\n'));
  for (const intentToAdd of [false, true]) {
    if (intentToAdd) await git.raw(['add', '--intent-to-add', '--', 'new.txt']);
    const index = await readFile(path.join(directory, '.git', 'index'));
    const stagedPatch = await git.diff(['--cached']);
    const unstaged = await review.files('unstaged');
    assert.equal(unstaged.length, 1);
    const [file] = unstaged;
    assert.equal(file.status, 'R');
    assert.equal(file.path, 'new.txt');
    assert.equal(file.originalPath, 'old.txt');
    assert.equal(file.notice, undefined);
    assert.equal(file.additions, 1);
    assert.equal(file.deletions, 1);
    assert.ok(review.expandAll(file).hunks[0].lines.some(line => line.kind === 'context' && line.text === 'indexed line'));
    const [uncommitted] = await review.files('uncommitted');
    assert.equal(uncommitted.status, 'R');
    assert.equal(uncommitted.additions, 2);
    assert.equal(uncommitted.deletions, 2);
    const [staged] = await review.files('staged');
    assert.equal(staged.path, 'old.txt');
    assert.equal(staged.status, 'M');
    assert.deepEqual(await readFile(path.join(directory, '.git', 'index')), index);
    assert.equal(await git.diff(['--cached']), stagedPatch);
  }
});

test('renaming a file into a directory does not include neighboring patches', async () => {
  const { directory, git, review } = await repository();
  await writeFile(path.join(directory, 'old'), 'one\ntwo\nthree\nfour\n');
  await git.add('.');
  await git.commit('initial');
  await rename(path.join(directory, 'old'), path.join(directory, 'temporary'));
  await mkdir(path.join(directory, 'old'));
  await rename(path.join(directory, 'temporary'), path.join(directory, 'old', 'new.txt'));
  await writeFile(path.join(directory, 'old', 'new.txt'), 'one\ntwo\nthree\nchanged\n');
  await writeFile(path.join(directory, 'old', 'neighbor.txt'), 'unrelated addition\n');
  for (const scope of ['unstaged', 'uncommitted', 'staged']) {
    if (scope === 'staged') await git.add('.');
    const files = await review.files(scope);
    assert.equal(files.length, 2);
    const file = files.find(file => file.path === 'old/new.txt');
    assert.equal(file.originalPath, 'old');
    assert.equal(file.status, 'R');
    assert.equal(file.notice, undefined);
    assert.equal(file.additions, 1);
    assert.equal(file.deletions, 1);
    assert.equal(file.hunks.flatMap(hunk => hunk.lines).some(line => line.text === 'unrelated addition'), false);
  }
});

test('rename previews retain the detected pairs when identical sources become sibling destinations', async () => {
  const { directory, git, review } = await repository();
  const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  await writeFile(path.join(directory, 'a'), original);
  await writeFile(path.join(directory, 'b'), original);
  await git.add('.');
  await git.commit('initial');
  await rename(path.join(directory, 'a'), path.join(directory, 'temporary'));
  await mkdir(path.join(directory, 'a'));
  await rename(path.join(directory, 'temporary'), path.join(directory, 'a', 'c'));
  await rename(path.join(directory, 'b'), path.join(directory, 'a', 'b'));
  await writeFile(path.join(directory, 'a', 'c'), original.replace('line 15\n', 'edited line\n'));

  for (const destinationState of ['untracked', 'intent-to-add', 'staged']) {
    if (destinationState === 'intent-to-add') await git.raw(['add', '--intent-to-add', '--', 'a/b', 'a/c']);
    if (destinationState === 'staged') await git.add('.');
    // Intent-to-add removes the old file "a" from the index to make room for "a/*".
    const scopes = destinationState === 'untracked' ? ['unstaged', 'uncommitted'] : destinationState === 'staged' ? ['staged', 'uncommitted'] : ['uncommitted'];
    for (const scope of scopes) {
      const files = await review.files(scope);
      assert.deepEqual(files.map(file => [file.originalPath, file.path, file.status]), [['b', 'a/b', 'R'], ['a', 'a/c', 'R']]);
      const [unchanged, edited] = files;
      assert.equal(unchanged.notice, 'File renamed without text changes.');
      assert.equal(unchanged.additions, 0);
      assert.equal(unchanged.deletions, 0);
      assert.equal(edited.notice, undefined, `${destinationState}: ${scope}`);
      assert.equal(edited.additions, 1);
      assert.equal(edited.deletions, 1);
      assert.deepEqual(edited.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind !== 'context'), [
        { kind: 'delete', text: 'line 15', oldLine: 15 },
        { kind: 'add', text: 'edited line', newLine: 15 },
      ]);
      const expanded = review.expandAll(edited);
      assert.deepEqual(expanded.gaps, []);
      assert.equal(expanded.hunks[0].lines[0].oldLine, 1);
      assert.equal(expanded.hunks[0].lines.at(-1).newLine, 30);
    }
  }
});

test('a failing untracked clean filter leaves the ordinary review available', async () => {
  const { directory, git, review } = await repository();
  await writeFile(path.join(directory, '.gitattributes'), '*.data filter=broken\n');
  await writeFile(path.join(directory, 'fail.cjs'), 'process.exit(1);\n');
  await writeFile(path.join(directory, 'old.txt'), 'moved contents\n');
  await writeFile(path.join(directory, 'app.txt'), 'before\n');
  await git.add('.');
  await git.commit('initial');
  await simpleGit({ baseDir: directory, unsafe: { allowUnsafeFilter: true } }).addConfig('filter.broken.clean', 'node fail.cjs');
  await git.addConfig('filter.broken.required', 'true');
  await rename(path.join(directory, 'old.txt'), path.join(directory, 'new.txt'));
  await writeFile(path.join(directory, 'app.txt'), 'after\n');
  await writeFile(path.join(directory, 'unrelated.data'), 'new data\n');
  const index = await readFile(path.join(directory, '.git', 'index'));
  for (const scope of ['unstaged', 'uncommitted']) {
    const files = await review.files(scope);
    assert.deepEqual(files.map(file => [file.path, file.status]), [['app.txt', 'M'], ['new.txt', '?'], ['old.txt', 'D'], ['unrelated.data', '?']]);
    assert.ok(files.every(file => file.notice === undefined));
    const app = files.find(file => file.path === 'app.txt');
    assert.deepEqual(app.hunks.flatMap(hunk => hunk.lines), [
      { kind: 'delete', text: 'before', oldLine: 1 },
      { kind: 'add', text: 'after', newLine: 1 },
    ]);
    assert.equal(files.find(file => file.path === 'new.txt').additions, 1);
    assert.equal(files.find(file => file.path === 'old.txt').deletions, 1);
    assert.equal(files.find(file => file.path === 'unrelated.data').additions, 1);
  }
  assert.deepEqual(await readFile(path.join(directory, '.git', 'index')), index);
  assert.deepEqual(await review.files('staged'), []);

  await rm(path.join(directory, 'unrelated.data'));
  assert.equal((await review.files('unstaged')).find(file => file.path === 'new.txt').status, 'R', 'Detection recovers on the next refresh');
});

test('untracked text and binary moves pair once while ignored files and unrelated additions stay separate', async () => {
  const { directory, git, review } = await repository();
  await writeFile(path.join(directory, '.gitignore'), '*.ignored\n');
  await writeFile(path.join(directory, 'old [v1] ü.txt'), 'rename this text\n');
  await writeFile(path.join(directory, 'old.bin'), Buffer.from([0, 42, 15, 12]));
  await writeFile(path.join(directory, 'deleted.txt'), 'nothing like the new file\n');
  await git.add('.');
  await git.commit('initial');
  await mkdir(path.join(directory, 'new directory'));
  await rename(path.join(directory, 'old [v1] ü.txt'), path.join(directory, 'new directory', 'new [v2] 日本.txt'));
  await rename(path.join(directory, 'old.bin'), path.join(directory, 'new.bin'));
  await rm(path.join(directory, 'deleted.txt'));
  await writeFile(path.join(directory, 'new.txt'), 'unrelated addition\n');
  await writeFile(path.join(directory, 'hidden.ignored'), 'nothing like the new file\n');
  await writeFile(path.join(directory, '.git', 'hooks', 'post-index-change'), '#!/bin/sh\nprintf invoked > hook-ran\n', { mode: 0o755 });
  const index = await readFile(path.join(directory, '.git', 'index'));
  const objects = (await readdir(path.join(directory, '.git', 'objects'), { recursive: true })).sort();
  const status = await git.raw(['--no-optional-locks', 'status', '--porcelain=v1', '-z']);
  for (const scope of ['unstaged', 'uncommitted']) {
    const files = await review.files(scope);
    assert.equal(files.length, 4);
    const moved = files.filter(file => file.status === 'R');
    assert.deepEqual(moved.map(file => [file.originalPath, file.path]), [['old [v1] ü.txt', 'new directory/new [v2] 日本.txt'], ['old.bin', 'new.bin']]);
    for (const file of moved) {
      assert.equal(file.notice, 'File renamed without text changes.');
      assert.equal(file.additions, 0);
      assert.equal(file.deletions, 0);
      assert.deepEqual(file.hunks, []);
    }
    assert.equal(files.find(file => file.path === 'deleted.txt').status, 'D');
    assert.equal(files.find(file => file.path === 'new.txt').status, '?');
  }
  assert.deepEqual(await review.files('staged'), []);
  assert.deepEqual(await readFile(path.join(directory, '.git', 'index')), index);
  assert.deepEqual((await readdir(path.join(directory, '.git', 'objects'), { recursive: true })).sort(), objects);
  assert.equal(await git.raw(['--no-optional-locks', 'status', '--porcelain=v1', '-z']), status);
  await assert.rejects(lstat(path.join(directory, 'hook-ran')), { code: 'ENOENT' });
});

test('a staged deletion and untracked destination are a rename only in uncommitted scope', async () => {
  const { directory, git, review } = await repository();
  await writeFile(path.join(directory, 'old.txt'), 'moved contents\n');
  await git.add('.');
  await git.commit('initial');
  await rename(path.join(directory, 'old.txt'), path.join(directory, 'new.txt'));
  await git.raw(['rm', '--cached', '--', 'old.txt']);
  assert.deepEqual((await review.files('uncommitted')).map(file => [file.path, file.originalPath, file.status]), [['new.txt', 'old.txt', 'R']]);
  assert.deepEqual((await review.files('staged')).map(file => [file.path, file.status]), [['old.txt', 'D']]);
  assert.deepEqual((await review.files('unstaged')).map(file => [file.path, file.status]), [['new.txt', '?']]);
});

test('untracked rename detection and previews honor Git text normalization', async () => {
  const { directory, git, review } = await repository();
  await writeFile(path.join(directory, '.gitattributes'), '*.txt text eol=crlf\n');
  await writeFile(path.join(directory, 'old.txt'), 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n');
  await git.add('.');
  await git.commit('initial');
  await rename(path.join(directory, 'old.txt'), path.join(directory, 'new.txt'));
  await writeFile(path.join(directory, 'new.txt'), 'one\r\ntwo\r\nthree\r\nfour\r\nchanged\r\n');
  const [file] = await review.files('unstaged');
  assert.equal(file.status, 'R');
  assert.equal(file.originalPath, 'old.txt');
  assert.equal(file.path, 'new.txt');
  assert.equal(file.notice, undefined);
  assert.equal(file.additions, 1);
  assert.equal(file.deletions, 1);
  assert.deepEqual(file.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind !== 'context'), [
    { kind: 'delete', text: 'five', oldLine: 5 },
    { kind: 'add', text: 'changed', newLine: 5 },
  ]);
});

test('untracked moves work in linked worktrees with split indexes without changing repository storage', async () => {
  const { directory, git } = await repository();
  await writeFile(path.join(directory, 'old.txt'), 'moved contents\n');
  await git.add('.');
  await git.commit('initial');
  const worktree = await mkdtemp(path.join(tmpdir(), 'difff-test-worktree-'));
  temporary.push(worktree);
  await git.raw(['worktree', 'add', '--detach', worktree]);
  const linked = simpleGit(worktree);
  await linked.raw(['update-index', '--split-index']);
  await rename(path.join(worktree, 'old.txt'), path.join(worktree, 'new.txt'));
  const indexPath = (await linked.raw(['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
  const index = await readFile(indexPath);
  const storage = (await readdir(path.join(directory, '.git'), { recursive: true })).sort();
  const review = new GitReview(worktree);
  for (const scope of ['unstaged', 'uncommitted']) {
    assert.deepEqual((await review.files(scope)).map(file => [file.path, file.originalPath, file.status]), [['new.txt', 'old.txt', 'R']]);
  }
  assert.deepEqual(await readFile(indexPath), index);
  assert.deepEqual((await readdir(path.join(directory, '.git'), { recursive: true })).sort(), storage);
});

test('rename comparison removes its temporary index and objects even if review fails', async () => {
  const { directory, git } = await repository();
  await writeFile(path.join(directory, 'old.txt'), 'moved contents\n');
  await git.add('.');
  await git.commit('initial');
  await rename(path.join(directory, 'old.txt'), path.join(directory, 'new.txt'));
  const index = await readFile(path.join(directory, '.git', 'index'));
  let comparisonDirectory;
  await assert.rejects(withUntrackedComparison(git, directory, [], new Set(['old.txt']), ['new.txt'], async comparison => {
    comparisonDirectory = path.dirname((await comparison.raw(['rev-parse', '--git-path', 'index'])).trim());
    throw new Error('Review interrupted');
  }), /Review interrupted/);
  assert.ok(comparisonDirectory);
  await assert.rejects(lstat(comparisonDirectory), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(directory, '.git', 'index')), index);
});

test('binary renames remain one file, with no invented text or context', async () => {
  const { directory, git, review } = await repository();
  const contents = Buffer.alloc(8192, 42);
  contents[0] = 0;
  await writeFile(path.join(directory, 'old.bin'), contents);
  await git.add('.');
  await git.commit('initial');
  await git.mv('old.bin', 'new.bin');
  for (const changed of [false, true]) {
    if (changed) {
      contents[100] = 10;
      await writeFile(path.join(directory, 'new.bin'), contents);
      await git.add('.');
    }
    for (const scope of ['staged', 'uncommitted']) {
      const files = await review.files(scope);
      assert.equal(files.length, 1);
      const [file] = files;
      assert.equal(file.status, 'R');
      assert.equal(file.path, 'new.bin');
      assert.equal(file.originalPath, 'old.bin');
      assert.match(file.notice, changed ? /Binary/ : /renamed/);
      assert.deepEqual(file.hunks, []);
      assert.deepEqual(file.gaps, []);
      assert.equal(file.additions, 0);
      assert.equal(file.deletions, 0);
    }
  }
});

test('recreated staged deletions compare the working file with HEAD in uncommitted scope', async () => {
  const { directory, git, review } = await repository();
  const filename = 'recreated [file].txt';
  const original = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
  const replacement = original.replace('line 15\n', 'replacement\n');
  await writeFile(path.join(directory, filename), original);
  await git.add('.');
  await git.commit('initial');
  await git.rm(filename);
  await writeFile(path.join(directory, filename), replacement);

  const [all] = await review.files('uncommitted');
  assert.equal(all.status, 'M');
  assert.equal(all.additions, 1);
  assert.equal(all.deletions, 1);
  assert.equal(all.notice, undefined);
  assert.deepEqual(all.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind === 'add'), [{ kind: 'add', text: 'replacement', newLine: 15 }]);
  const expanded = review.expandAll(all);
  assert.equal(expanded.gaps.length, 0);
  assert.equal(expanded.hunks[0].oldLines, 30);
  assert.equal(expanded.hunks[0].newLines, 30);

  const [staged] = await review.files('staged');
  assert.equal(staged.status, 'D');
  assert.equal(staged.additions, 0);
  assert.equal(staged.deletions, 30);
  const [unstaged] = await review.files('unstaged');
  assert.equal(unstaged.status, '?');
  assert.equal(unstaged.additions, 30);
  assert.equal(unstaged.deletions, 0);

  await writeFile(path.join(directory, filename), original);
  assert.deepEqual(await review.files('uncommitted'), []);
  assert.equal((await review.files('staged'))[0].status, 'D');
  assert.equal((await review.files('unstaged'))[0].status, '?');
});

for (const normalization of ['autocrlf', 'attributes', 'clean filter']) {
  test(`recreated files use Git normalization from ${normalization}`, async () => {
    const { directory, git, review } = await repository();
    const filename = 'recreated [file].txt';
    const absolute = path.join(directory, filename);
    let original = 'alpha\r\nbeta\r\n';
    let changed = 'alpha\r\nchanged\r\n';
    if (normalization === 'autocrlf') await git.addConfig('core.autocrlf', 'true');
    else if (normalization === 'attributes') await writeFile(path.join(directory, '.gitattributes'), '*.txt text eol=crlf\n');
    else {
      await writeFile(path.join(directory, '.gitattributes'), '*.txt filter=review\n');
      await writeFile(path.join(directory, 'clean.cjs'), "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => process.stdout.write(input.replaceAll('worktree:', '')));\n");
      await simpleGit({ baseDir: directory, unsafe: { allowUnsafeFilter: true } }).addConfig('filter.review.clean', 'node clean.cjs');
      original = 'worktree:alpha\nworktree:beta\n';
      changed = 'worktree:alpha\nworktree:changed\n';
    }
    await writeFile(absolute, original);
    await git.add('.');
    await git.commit('initial');
    assert.equal(await git.show([`HEAD:${filename}`]), 'alpha\nbeta\n');
    await git.raw(['rm', '--cached', '--', filename]);
    const index = await git.raw(['ls-files', '--stage', '-z']);
    assert.deepEqual(await review.files('uncommitted'), []);

    await writeFile(absolute, changed);
    const [file] = await review.files('uncommitted');
    assert.equal(file.path, filename);
    assert.equal(file.additions, 1);
    assert.equal(file.deletions, 1);
    assert.equal(file.notice, undefined);
    assert.deepEqual(file.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind !== 'context'), [
      { kind: 'delete', text: 'beta', oldLine: 2 },
      { kind: 'add', text: 'changed', newLine: 2 },
    ]);
    assert.equal((await review.files('staged'))[0].status, 'D');
    assert.equal((await review.files('unstaged'))[0].status, '?');
    assert.equal(await git.raw(['ls-files', '--stage', '-z']), index, 'Reviewing must not update the index');
  });
}

test('recreated files preserve line-ending changes when whitespace is included and attributes disable normalization', async () => {
  const { directory, git, review } = await repository();
  await git.addConfig('core.autocrlf', 'true');
  await writeFile(path.join(directory, '.gitattributes'), '*.txt -text\n');
  await writeFile(path.join(directory, 'literal.txt'), 'alpha\nbeta\n');
  await git.add('.');
  await git.commit('initial');
  await git.raw(['rm', '--cached', 'literal.txt']);
  await writeFile(path.join(directory, 'literal.txt'), 'alpha\r\nbeta\r\n');
  assert.deepEqual(await review.files('uncommitted'), []);
  const [file] = await new GitReview(directory, false).files('uncommitted');
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 2);
});

for (const trigger of ['filename', 'content']) {
  test(`recreated text files containing Binary files in their ${trigger} remain reviewable`, async () => {
    const { directory, git, review } = await repository();
    const filename = trigger === 'filename' ? 'Binary files.txt' : 'guide.txt';
    const changed = trigger === 'content' ? 'Binary files are skipped.' : 'new text';
    await writeFile(path.join(directory, filename), 'old text\n');
    await git.add('.');
    await git.commit('initial');
    await git.raw(['rm', '--cached', '--', filename]);
    await writeFile(path.join(directory, filename), `${changed}\n`);
    const [file] = await review.files('uncommitted');
    assert.equal(file.notice, undefined);
    assert.equal(file.additions, 1);
    assert.equal(file.deletions, 1);
    assert.deepEqual(file.hunks.flatMap(hunk => hunk.lines), [
      { kind: 'delete', text: 'old text', oldLine: 1 },
      { kind: 'add', text: changed, newLine: 1 },
    ]);
  });
}

test('metadata-only changes in a file named Binary files are not reported as binary', async () => {
  const { directory, git, review } = await repository();
  const filename = 'Binary files.txt';
  await writeFile(path.join(directory, filename), 'unchanged\n');
  await git.add('.');
  await git.raw(['update-index', '--chmod=-x', '--', filename]);
  await git.commit('initial');
  await git.raw(['update-index', '--chmod=+x', '--', filename]);
  const [file] = await review.files('staged');
  assert.match(file.notice, /metadata changed/);
  assert.deepEqual(file.hunks, []);
});

test('tracked and recreated files retain binary differences requested by attributes', async () => {
  const { directory, git, review } = await repository();
  await writeFile(path.join(directory, '.gitattributes'), '*.txt -diff\n');
  await writeFile(path.join(directory, 'binary.txt'), 'before\n');
  await git.add('.');
  await git.commit('initial');
  await writeFile(path.join(directory, 'binary.txt'), 'after\n');
  const [tracked] = await review.files('uncommitted');
  assert.equal(tracked.path, 'binary.txt');
  assert.match(tracked.notice, /Binary/);
  await git.raw(['rm', '--cached', 'binary.txt']);
  const [file] = await review.files('uncommitted');
  assert.equal(file.path, 'binary.txt');
  assert.match(file.notice, /Binary/);
});

test('submodule previews use commit pointers regardless of configured diff format', async () => {
  const { directory, git, review } = await repository();
  const subdirectory = path.join(directory, 'lib');
  await mkdir(subdirectory);
  const submodule = simpleGit(subdirectory);
  await submodule.init();
  await submodule.addConfig('user.name', 'Diff Test');
  await submodule.addConfig('user.email', 'diff@example.test');
  await submodule.addConfig('core.autocrlf', 'false');
  await writeFile(path.join(subdirectory, 'a.txt'), 'a1\na2\na3\n');
  await writeFile(path.join(subdirectory, 'b.txt'), 'b1\nb2\nb3\n');
  await submodule.add('.');
  await submodule.commit('initial');
  const previous = (await submodule.revparse(['HEAD'])).trim();
  await writeFile(path.join(directory, '.gitmodules'), '[submodule "lib"]\n\tpath = lib\n\turl = ./lib\n');
  await git.add('.');
  await git.commit('add submodule');
  await writeFile(path.join(subdirectory, 'a.txt'), 'a1\na2 changed\na3\n');
  await writeFile(path.join(subdirectory, 'b.txt'), 'b1\nb2 changed\nb3\n');
  await submodule.commit('change both files', ['-a']);
  const current = (await submodule.revparse(['HEAD'])).trim();
  for (const format of ['diff', 'log']) {
    await git.addConfig('diff.submodule', format);
    for (const scope of ['uncommitted', 'unstaged', 'staged']) {
      if (scope === 'staged') await git.add('lib');
      const [file] = await review.files(scope);
      assert.equal(file.path, 'lib');
      assert.equal(file.notice, undefined);
      assert.deepEqual(file.gaps, []);
      assert.equal(file.hunks.length, 1);
      assert.deepEqual(file.hunks[0].lines, [
        { kind: 'delete', text: `Subproject commit ${previous}`, oldLine: 1 },
        { kind: 'add', text: `Subproject commit ${current}`, newLine: 1 },
      ]);
    }
    await git.raw(['reset', 'HEAD', '--', 'lib']);
  }
  await submodule.raw(['checkout', previous]);
  await rename(subdirectory, path.join(directory, 'moved-lib'));
  await writeFile(path.join(directory, '.gitmodules'), '[submodule "lib"]\n\tpath = moved-lib\n\turl = ./lib\n');
  await git.add('.');
  for (const scope of ['uncommitted', 'staged']) {
    const file = (await review.files(scope)).find(file => file.path === 'moved-lib');
    assert.equal(file.status, 'R');
    assert.equal(file.originalPath, 'lib');
    assert.equal(file.notice, 'File renamed without text changes.');
    assert.deepEqual(file.gaps, []);
    assert.deepEqual(file.hunks, []);
  }
});

test('renamed submodule previews keep their own size limit alongside large unrelated patches', async () => {
  const { directory, git, review } = await repository();
  const subdirectory = path.join(directory, 'lib');
  await mkdir(subdirectory);
  const submodule = simpleGit(subdirectory);
  await submodule.init();
  await submodule.addConfig('user.name', 'Diff Test');
  await submodule.addConfig('user.email', 'diff@example.test');
  await submodule.addConfig('core.autocrlf', 'false');
  await writeFile(path.join(subdirectory, 'source.txt'), 'original\n');
  await submodule.add('.');
  await submodule.commit('initial');
  const commit = (await submodule.revparse(['HEAD'])).trim();
  await writeFile(path.join(directory, '.gitmodules'), '[submodule "lib"]\n\tpath = lib\n\turl = ./lib\n');
  await git.add('.');
  await git.commit('initial');
  await rename(subdirectory, path.join(directory, 'moved-lib'));
  await writeFile(path.join(directory, '.gitmodules'), '[submodule "lib"]\n\tpath = moved-lib\n\turl = ./lib\n');
  // Source lines resembling patch headers must not be mistaken for file boundaries.
  await writeFile(path.join(directory, 'a-large.txt'), 'diff --git a/example b/example\n@@ -1 +1 @@\n'.repeat(55000));
  await writeFile(path.join(directory, 'z-small.txt'), 'unrelated\n');
  await git.add('.');
  await writeFile(path.join(directory, 'moved-lib', 'source.txt'), 'changed\n');

  for (const scope of ['staged', 'uncommitted']) {
    const files = await review.files(scope);
    const file = files.find(file => file.path === 'moved-lib');
    assert.equal(file.status, 'R');
    assert.equal(file.originalPath, 'lib');
    assert.deepEqual(file.gaps, []);
    assert.equal(file.notice, scope === 'staged' ? 'File renamed without text changes.' : undefined);
    assert.equal(file.additions, scope === 'staged' ? 0 : 1);
    assert.equal(file.deletions, scope === 'staged' ? 0 : 1);
    assert.deepEqual(file.hunks.flatMap(hunk => hunk.lines), scope === 'staged' ? [] : [
      { kind: 'delete', text: `Subproject commit ${commit}`, oldLine: 1 },
      { kind: 'add', text: `Subproject commit ${commit}-dirty`, newLine: 1 },
    ]);
    assert.match(files.find(file => file.path === 'a-large.txt').notice, /Diff exceeds the 2 MB preview limit/);
    assert.equal(files.find(file => file.path === 'z-small.txt').additions, 1);
  }
});

test('symlink-to-file type changes preserve both patches without expandable context', async () => {
  const { directory, git, review } = await repository();
  const filename = 'link.txt';
  const absolute = path.join(directory, filename);
  await git.addConfig('core.symlinks', 'true');
  // Record a symlink in Git without requiring Windows permission to create one on disk.
  await writeFile(absolute, 'target.txt');
  const blob = (await git.raw(['hash-object', '-w', '--', filename])).trim();
  await git.raw(['update-index', '--add', '--cacheinfo', `120000,${blob},${filename}`]);
  await git.commit('initial symlink');
  await writeFile(absolute, 'hello\n');

  for (const scope of ['unstaged', 'uncommitted', 'staged']) {
    if (scope === 'staged') await git.add(filename);
    const [file] = await review.files(scope);
    assert.equal(file.status, 'T');
    assert.equal(file.notice, undefined);
    assert.equal(file.additions, 1);
    assert.equal(file.deletions, 1);
    assert.equal(file.hunks.length, 2);
    assert.deepEqual(file.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind !== 'note'), [
      { kind: 'delete', text: 'target.txt', oldLine: 1 },
      { kind: 'add', text: 'hello', newLine: 1 },
    ]);
    assert.deepEqual(file.gaps, []);
    assert.deepEqual(review.expandAll(file), file);
    assert.deepEqual(review.reveal(file, 'new', 2), file, 'Revealing a line must not invent context in the new file');
  }
});

test('first-line additions and last-line removals have no phantom context', async () => {
  const { directory, git, review } = await repository();
  await writeFile(path.join(directory, 'empty.txt'), '');
  await writeFile(path.join(directory, 'one.txt'), 'last line\n');
  await git.add('.');
  await git.commit('initial');
  await writeFile(path.join(directory, 'empty.txt'), 'first line\n');
  await writeFile(path.join(directory, 'one.txt'), '');
  for (const scope of ['unstaged', 'uncommitted', 'staged']) {
    if (scope === 'staged') await git.add('.');
    const files = await review.files(scope);
    assert.equal(files.length, 2);
    for (const file of files) {
      assert.deepEqual(file.gaps, []);
      const expanded = review.expandAll(file);
      assert.deepEqual(expanded.gaps, []);
      assert.equal(expanded.hunks.length, 1);
      assert.equal(expanded.hunks[0].lines.length, 1);
    }
    assert.equal(files.find(file => file.path === 'empty.txt').hunks[0].header, '@@ −0,0 +1,1 @@');
    assert.equal(files.find(file => file.path === 'one.txt').hunks[0].header, '@@ −1,1 +0,0 @@');
  }
});

test('unmerged status survives duplicate modified entries until the resolution is staged', async () => {
  const { directory, git, review } = await repository();
  const filename = 'settings.txt';
  const absolute = path.join(directory, filename);
  await writeFile(absolute, 'timeout=10\n');
  await git.add('.');
  await git.commit('initial');
  const branch = (await git.raw(['branch', '--show-current'])).trim();
  await git.raw(['checkout', '-b', 'incoming']);
  await writeFile(absolute, 'timeout=30\n');
  await git.commit('incoming change', ['-a']);
  await git.raw(['checkout', branch]);
  await writeFile(absolute, 'timeout=20\n');
  await git.commit('current change', ['-a']);
  const mergeOutput = await git.raw(['merge', 'incoming']).catch(error => error.message);
  assert.match(mergeOutput, /CONFLICT/);
  assert.equal(await git.raw(['diff', '--name-status', '-z', '--no-renames', '--']), `U\0${filename}\0M\0${filename}\0`);

  const unstaged = await review.files('unstaged');
  assert.equal(unstaged.length, 1);
  assert.equal(unstaged[0].status, 'U');
  assert.match(unstaged[0].notice, /Unresolved merge conflict/);
  assert.deepEqual(unstaged[0].hunks, []);
  const [uncommitted] = await review.files('uncommitted');
  assert.ok(uncommitted.hunks.some(hunk => hunk.lines.some(line => line.text === '<<<<<<< HEAD')));

  await writeFile(absolute, 'timeout=30\n');
  const [resolvedButUnstaged] = await review.files('unstaged');
  assert.equal(resolvedButUnstaged.status, 'U');
  assert.match(resolvedButUnstaged.notice, /Unresolved merge conflict/);
  await git.add(filename);
  assert.deepEqual(await review.files('unstaged'), []);
  const [staged] = await review.files('staged');
  assert.equal(staged.status, 'M');
  assert.equal(staged.notice, undefined);
});

test('whitespace is ignored by default in every scope and can be included again', async () => {
  const { directory, git, review } = await repository();
  const original = 'const answer = 42;\n\treturn answer;\n';
  await writeFile(path.join(directory, 'spacing.txt'), original);
  await git.add('.');
  await git.commit('initial');
  await writeFile(path.join(directory, 'spacing.txt'), '  const answer=42;  \n return\tanswer;\n');
  await git.add('.');
  await writeFile(path.join(directory, 'spacing.txt'), '\tconstanswer = 42;\r\nreturnanswer; \r\n');
  const includeWhitespace = new GitReview(directory, false);
  for (const scope of ['uncommitted', 'staged', 'unstaged']) {
    assert.deepEqual(await review.files(scope), [], scope);
    const [file] = await includeWhitespace.files(scope);
    assert.equal(file.path, 'spacing.txt', scope);
    assert.equal(file.additions, 2, scope);
    assert.equal(file.deletions, 2, scope);
  }
  await git.raw(['rm', '--cached', '-f', 'spacing.txt']);
  assert.deepEqual(await review.files('uncommitted'), [], 'Recreated files use the same whitespace setting');
  assert.equal((await includeWhitespace.files('uncommitted'))[0].additions, 2);
});

test('ignored whitespace preserves current context, both comment anchors, and line numbers through expansion', async () => {
  const { directory, git, review } = await repository();
  const filename = 'context.txt';
  const original = Array.from({ length: 70 }, (_, index) => `line ${index + 1}`);
  await writeFile(path.join(directory, filename), original.join('\n') + '\n');
  await git.add('.');
  await git.commit('initial');
  const changed = original.map(line => `\t${line.replace(' ', '')}  `);
  changed.splice(19, 1, '  changed value  ', 'inserted line');
  changed.splice(50, 1);
  await writeFile(path.join(directory, filename), changed.join('\n') + '\n');
  for (const scope of ['unstaged', 'uncommitted', 'staged']) {
    if (scope === 'staged') await git.add('.');
    const [file] = await review.files(scope);
    assert.equal(file.notice, undefined, scope);
    assert.equal(file.additions, 2);
    assert.equal(file.deletions, 2);
    assert.equal(findAnchor(file, 'new', 18).text, changed[17]);
    assert.equal(findAnchor(file, 'old', 18).text, original[17]);
    assert.ok(file.gaps.length > 0);
    const revealed = review.reveal(file, 'new', 40);
    assert.equal(findAnchor(revealed, 'new', 40).text, changed[39]);
    assert.equal(findAnchor(revealed, 'old', 39).text, original[38]);
    const expanded = review.expandAll(review.expand(file, file.gaps[0].id, 'up'));
    assert.deepEqual(expanded.gaps, []);
    const lines = expanded.hunks.flatMap(hunk => hunk.lines);
    assert.deepEqual(lines.filter(line => line.oldLine).map(line => findAnchor(expanded, 'old', line.oldLine).text), original);
    assert.deepEqual(lines.filter(line => line.newLine).map(line => line.text), changed);
    assert.deepEqual(lines.filter(line => line.newLine).map(line => line.newLine), changed.map((_, index) => index + 1));
  }
});

test('ignored whitespace keeps context expandable without a trailing newline', async () => {
  const { directory, git, review } = await repository();
  const original = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n');
  await writeFile(path.join(directory, 'no-newline.txt'), original);
  await git.add('.');
  await git.commit('initial');
  const changed = original.replace('line 10', 'changed line').replace('line 40', '  line40  ');
  await writeFile(path.join(directory, 'no-newline.txt'), changed);
  for (const scope of ['unstaged', 'uncommitted', 'staged']) {
    if (scope === 'staged') await git.add('.');
    const [file] = await review.files(scope);
    assert.equal(file.notice, undefined, scope);
    assert.ok(file.gaps.length > 0, scope);
    assert.equal(file.additions, 1);
    assert.equal(file.deletions, 1);
    const revealed = review.reveal(file, 'new', 40);
    assert.equal(findAnchor(revealed, 'new', 40).text, '  line40  ');
    assert.equal(findAnchor(revealed, 'old', 40).text, 'line 40');
    const expanded = review.expandAll(file);
    assert.deepEqual(expanded.gaps, []);
    assert.deepEqual(expanded.hunks.flatMap(hunk => hunk.lines).filter(line => line.newLine).map(line => line.text), changed.split('\n'));
  }
});

test('ignoring whitespace keeps blank-line insertions, new files, deletions, renames, and mode changes', async () => {
  const { directory, git, review } = await repository();
  const original = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`).join('');
  await writeFile(path.join(directory, 'old.txt'), original);
  await writeFile(path.join(directory, 'deleted.txt'), ' \t\n');
  await writeFile(path.join(directory, 'blank.txt'), 'before\nafter\n');
  await writeFile(path.join(directory, 'mode.txt'), 'same text\n');
  await git.add('.');
  await git.raw(['update-index', '--chmod=-x', 'mode.txt']);
  await git.commit('initial');
  await rename(path.join(directory, 'old.txt'), path.join(directory, 'new.txt'));
  await writeFile(path.join(directory, 'new.txt'), original.replace('line 15', '  line15  '));
  await writeFile(path.join(directory, 'blank.txt'), 'before\n  \nafter\n');
  await writeFile(path.join(directory, 'mode.txt'), 'same\ttext  \n');
  await writeFile(path.join(directory, 'added.txt'), '\t\n');
  await git.rm('deleted.txt');
  const renamed = (await review.files('uncommitted')).find(file => file.path === 'new.txt');
  assert.equal(renamed.originalPath, 'old.txt');
  assert.equal(renamed.path, 'new.txt');
  assert.deepEqual(renamed.hunks, []);
  assert.match(renamed.notice, /renamed/);
  await git.add('.');
  await git.raw(['update-index', '--chmod=+x', 'mode.txt']);
  const files = await review.files('staged');
  assert.equal(files.find(file => file.path === 'added.txt').additions, 1);
  assert.equal(files.find(file => file.path === 'deleted.txt').deletions, 1);
  assert.equal(files.find(file => file.path === 'blank.txt').additions, 1);
  assert.deepEqual(files.find(file => file.path === 'new.txt').hunks, []);
  assert.match(files.find(file => file.path === 'mode.txt').notice, /metadata/);
});

test('comment export is location-aware and inbound comment messages are validated', () => {
  const text = formatComments([
    { path: 'src/a.ts', line: 8, scope: 'unstaged', side: 'old', body: 'Explain this.\nMore detail.' },
    { path: 'src/b.ts', line: 12, scope: 'staged', side: 'new', body: 'Add validation.' },
  ]);
  assert.equal(text, 'src/a.ts:8\nExplain this.\nMore detail.\n\nsrc/b.ts:12\nAdd validation.');
  assert.equal(messageSchema.safeParse({ type: 'comment', path: 'a', side: 'old', line: 0, body: 'x' }).success, false);
  assert.equal(messageSchema.safeParse({ type: 'edit', id: 'a', body: '   ' }).success, false);
});
