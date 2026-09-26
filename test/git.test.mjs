import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { simpleGit } from 'simple-git';

await build({ entryPoints: ['src/git.ts', 'src/model.ts', 'src/validation.ts'], outdir: '.tools/tests', bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const require = createRequire(import.meta.url);
const { GitReview } = require('../.tools/tests/git.js');
const { formatComments } = require('../.tools/tests/model.js');
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
  assert.deepEqual(all.map(file => file.status).sort(), ['A', 'D']);
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

test('recreated files preserve line-ending changes when attributes disable normalization', async () => {
  const { directory, git, review } = await repository();
  await git.addConfig('core.autocrlf', 'true');
  await writeFile(path.join(directory, '.gitattributes'), '*.txt -text\n');
  await writeFile(path.join(directory, 'literal.txt'), 'alpha\nbeta\n');
  await git.add('.');
  await git.commit('initial');
  await git.raw(['rm', '--cached', 'literal.txt']);
  await writeFile(path.join(directory, 'literal.txt'), 'alpha\r\nbeta\r\n');
  const [file] = await review.files('uncommitted');
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

test('comment export is location-aware and inbound comment messages are validated', () => {
  const text = formatComments([
    { path: 'src/a.ts', line: 8, scope: 'unstaged', side: 'old', body: 'Explain this.\nMore detail.' },
    { path: 'src/b.ts', line: 12, scope: 'staged', side: 'new', body: 'Add validation.' },
  ]);
  assert.equal(text, 'src/a.ts:8\nExplain this.\nMore detail.\n\nsrc/b.ts:12\nAdd validation.');
  assert.equal(messageSchema.safeParse({ type: 'comment', path: 'a', side: 'old', line: 0, body: 'x' }).success, false);
  assert.equal(messageSchema.safeParse({ type: 'edit', id: 'a', body: '   ' }).success, false);
});
