import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';

// Compare only unmatched deletions and untracked files. Both the index and newly
// written Git objects belong to this comparison, never to the user's repository.
export async function withUntrackedComparison<T>(git: SimpleGit, root: string, base: string[], deleted: Set<string>, untracked: string[], review: (comparison: SimpleGit, tree: string) => Promise<T[]>): Promise<T[]> {
  if (!deleted.size || !untracked.length) return [];
  const candidates: string[] = [];
  for (const file of untracked) {
    const info = await lstat(path.join(root, file)).catch(() => undefined);
    // Nested repositories are not individual untracked files.
    if (info?.isFile() || info?.isSymbolicLink()) candidates.push(file);
  }
  if (!candidates.length) return [];

  const raw = (await git.raw(['diff', ...base, '--raw', '--no-abbrev', '--no-renames', '--diff-filter=D', '-z', '--no-ext-diff', '--no-textconv', '--'])).split('\0');
  let sources = '';
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const file = raw[i + 1];
    const [mode, , object] = raw[i]?.slice(1).split(' ') ?? [];
    if (file && deleted.has(file) && mode && object) sources += `${mode} ${object}\t${file}\0`;
  }
  if (!sources) return [];

  const parent = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(parent, 'difff-renames-'));
  if (path.dirname(directory) !== parent || !path.basename(directory).startsWith('difff-renames-')) throw new Error('Unexpected rename comparison directory.');
  try {
    const objects = path.join(directory, 'objects');
    const hooks = path.join(directory, 'hooks');
    await mkdir(objects);
    await mkdir(hooks);
    const repositoryObjects = (await git.raw(['rev-parse', '--path-format=absolute', '--git-path', 'objects'])).trim();
    const comparison = simpleGit({
      baseDir: root,
      maxConcurrentProcesses: 4,
      timeout: { block: 30000 },
      config: ['core.splitIndex=false', 'core.sparseCheckout=false', 'index.sparse=false', `core.hooksPath=${hooks}`],
      // Only point hooks at the empty directory we just created; index writes must not run repository hooks.
      unsafe: { allowUnsafeHooksPath: true },
      allowEnvironment: ['GIT_LITERAL_PATHSPECS', 'GIT_OPTIONAL_LOCKS', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'],
      input: commands => commands.includes('--index-info') ? sources : commands.includes('--pathspec-from-file=-') ? `${candidates.join('\0')}\0` : undefined,
    });
    comparison.env('GIT_LITERAL_PATHSPECS', '1').env('GIT_OPTIONAL_LOCKS', '0')
      .env('GIT_INDEX_FILE', path.join(directory, 'index'))
      .env('GIT_OBJECT_DIRECTORY', objects)
      .env('GIT_ALTERNATE_OBJECT_DIRECTORIES', JSON.stringify(repositoryObjects));

    await comparison.raw(['update-index', '-z', '--index-info']);
    const tree = (await comparison.raw(['write-tree'])).trim();
    // Starting a fresh destination index also permits file-to-directory moves.
    // Accepted limitation: the fresh index loses the .gitattributes fallback when the worktree copy is missing.
    // This edge case (e.g. an unstaged attributes deletion) is intentionally unhandled and can inflate rename diffs.
    await comparison.raw(['read-tree', '--empty']);
    await comparison.raw(['add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul']);
    return await review(comparison, tree);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
