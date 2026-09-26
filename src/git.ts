import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parsePatch, structuredPatch, type StructuredPatchHunk } from 'diff';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { DiffLine, Hunk, ReviewFile, Scope, Side } from './model';
import { contextGaps, expandAllContext, expandContext, header, revealContextLine } from './context';

const MAX_BYTES = 2 * 1024 * 1024;

function toHunk(hunk: StructuredPatchHunk): Hunk {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const lines: DiffLine[] = hunk.lines.map(line => {
    const text = line.slice(1).replace(/\r$/, '');
    if (line[0] === '+') return { kind: 'add', text, newLine: newLine++ };
    if (line[0] === '-') return { kind: 'delete', text, oldLine: oldLine++ };
    if (line[0] === ' ') return { kind: 'context', text, oldLine: oldLine++, newLine: newLine++ };
    return { kind: 'note', text: line };
  });
  return header({ header: '', oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, lines });
}

export class GitReview {
  private readonly git: SimpleGit;
  private readonly sources = new Map<string, string[]>();

  constructor(readonly root: string) {
    this.git = simpleGit({ baseDir: root, maxConcurrentProcesses: 4, timeout: { block: 30000 }, allowEnvironment: ['GIT_LITERAL_PATHSPECS', 'GIT_OPTIONAL_LOCKS'] });
    // Paths are passed as separate argv entries; literal pathspecs also handle [] and leading colons.
    this.git.env('GIT_LITERAL_PATHSPECS', '1').env('GIT_OPTIONAL_LOCKS', '0');
  }

  async branch(): Promise<string> {
    return (await this.git.raw(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => 'detached HEAD')).trim();
  }

  private async baseArgs(scope: Scope): Promise<string[]> {
    if (scope === 'unstaged') return [];
    if (scope === 'staged') return ['--cached'];
    const head = await this.git.raw(['rev-parse', '--verify', 'HEAD']).catch(() => '');
    // The canonical empty tree does not require writing an object or opening a stdin stream.
    const format = head.trim() ? '' : (await this.git.raw(['rev-parse', '--show-object-format'])).trim();
    const base = head.trim() || createHash(format === 'sha256' ? 'sha256' : 'sha1').update('tree 0\0').digest('hex');
    return [base];
  }

  async files(scope: Scope): Promise<ReviewFile[]> {
    const base = await this.baseArgs(scope);
    const names = await this.git.raw(['diff', ...base, '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--']);
    const entries = names.split('\0');
    const paths = new Map<string, string>();
    const recreated = new Set<string>();
    for (let i = 0; i + 1 < entries.length; i += 2) {
      const file = entries[i + 1];
      // Git can report both U and M for the same conflicted path.
      if (file && paths.get(file) !== 'U') paths.set(file, entries[i] ?? 'M');
    }
    if (scope !== 'staged') {
      const untracked = await this.git.raw(['ls-files', '--others', '--exclude-standard', '-z']);
      for (const file of untracked.split('\0')) {
        if (!file) continue;
        if (scope === 'uncommitted' && paths.get(file) === 'D') {
          paths.set(file, 'M');
          recreated.add(file);
        } else if (!paths.has(file)) paths.set(file, '?');
      }
    }
    const files: ReviewFile[] = [];
    // Keep file reads and patch parsing bounded even in a very large worktree.
    const pending = [...paths.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (let i = 0; i < pending.length; i += 4) {
      const batch = await Promise.all(pending.slice(i, i + 4).map(([file, status]) => this.file(file, status, base, recreated.has(file))));
      files.push(...batch.filter((file): file is ReviewFile => file !== undefined));
    }
    return files;
  }

  expand(file: ReviewFile, gap: string, direction: 'up' | 'down'): ReviewFile {
    const source = this.sources.get(file.snapshot);
    return source ? expandContext(file, source, gap, direction) : file;
  }

  expandAll(file: ReviewFile): ReviewFile {
    const source = this.sources.get(file.snapshot);
    return source ? expandAllContext(file, source) : file;
  }

  reveal(file: ReviewFile, side: Side, line: number): ReviewFile {
    const source = this.sources.get(file.snapshot);
    return source ? revealContextLine(file, source, side, line) : file;
  }

  private async patch(file: string, base: string[]): Promise<string> {
    // Preserve the context prefix on blank lines so parsing advances both line counters.
    return this.git.raw(['-c', 'diff.suppressBlankEmpty=false', 'diff', ...base, '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--submodule=short', '--unified=3', '--', file]);
  }

  private async file(file: string, status: string, base: string[], recreated = false): Promise<ReviewFile | undefined> {
    const result: ReviewFile = { path: file, status, additions: 0, deletions: 0, hunks: [], snapshot: randomUUID(), gaps: [] };
    try {
      let hunks: StructuredPatchHunk[];
      let original: string | undefined;
      if (status === '?' || recreated) {
        const absolute = this.resolve(file);
        const info = await lstat(absolute);
        if (!info.isFile()) return { ...result, notice: 'Symbolic link or nested repository. Open the file to inspect it.' };
        if (info.size > MAX_BYTES) return { ...result, notice: 'File exceeds the 2 MB preview limit. Open it in the editor to review.' };
        const buffer = await readFile(absolute);
        if (buffer.includes(0)) return { ...result, notice: 'Binary file — no text preview.' };
        original = recreated ? await this.git.show([`${base[0] ?? 'HEAD'}:${file}`]) : '';
        if (Buffer.byteLength(original) > MAX_BYTES) return { ...result, notice: 'Original file exceeds the 2 MB preview limit. Open it in the editor to review.' };
        if (original.includes('\0')) return { ...result, notice: 'Binary file — no text preview.' };
        if (recreated) {
          // Compare the HEAD blob directly with the working file so Git applies its attributes and clean filters.
          const patch = await this.patch(file, [`${base[0] ?? 'HEAD'}:${file}`]);
          if (Buffer.byteLength(patch) > MAX_BYTES) return { ...result, notice: 'Diff exceeds the 2 MB preview limit. Open it in the editor to review.' };
          const parts = parsePatch(patch);
          if (parts.some(part => part.isBinary)) return { ...result, notice: 'Binary file — no text preview.' };
          hunks = parts.flatMap(part => part.hunks);
        } else hunks = structuredPatch('/dev/null', file, original, buffer.toString('utf8'), '', '', { context: 3 }).hunks;
        if (recreated && !hunks.length) {
          const treeEntry = await this.git.raw(['ls-tree', '-z', base[0] ?? 'HEAD', '--', file]);
          const mode = treeEntry.slice(0, 6);
          const checkMode = (await this.git.raw(['config', '--bool', 'core.filemode']).catch(() => 'false')).trim() === 'true';
          const workingMode = info.mode & 0o111 ? '100755' : '100644';
          if (mode.startsWith('100') && (!checkMode || mode === workingMode)) return undefined;
          result.notice = 'File metadata changed.';
        }
      } else {
        const patch = await this.patch(file, base);
        if (Buffer.byteLength(patch) > MAX_BYTES) return { ...result, notice: 'Diff exceeds the 2 MB preview limit. Open it in the editor to review.' };
        const parts = parsePatch(patch);
        hunks = parts.flatMap(part => part.hunks);
        if (!hunks.length) result.notice = parts.some(part => part.isBinary) ? 'Binary file — no text preview.' : 'File metadata changed, or no text changes remain.';
      }
      result.hunks = hunks.map(toHunk);
      for (const hunk of result.hunks) for (const line of hunk.lines) {
        if (line.kind === 'add') result.additions++;
        if (line.kind === 'delete') result.deletions++;
      }
      if (status === 'U') result.notice = 'Unresolved merge conflict. Resolve the conflict in the editor before completing your review.';
      else if (status !== 'A' && status !== '?' && status !== 'T' && result.hunks.length && !result.hunks.some(hunk => hunk.lines.some(line => line.text.startsWith('Subproject commit ')))) {
        const revision = base.length === 0 ? ':' : base[0] === '--cached' ? 'HEAD:' : `${base[0] ?? 'HEAD'}:`;
        original ??= await this.git.show([`${revision}${file}`]);
        if (Buffer.byteLength(original) <= MAX_BYTES) {
          const source = original === '' ? [] : original.split('\n');
          if (source.at(-1) === '') source.pop();
          const normalized = source.map(line => line.replace(/\r$/, ''));
          const matches = result.hunks.every(hunk => hunk.lines.every(line => line.oldLine === undefined || normalized[line.oldLine - 1] === line.text));
          if (matches) {
            this.sources.set(result.snapshot, normalized);
            result.gaps = contextGaps(result.hunks, normalized.length);
          } else result.notice = 'Source changed while loading. Refresh to expand context.';
        } else result.notice = 'Additional context exceeds the 2 MB source limit. Open the file to see more.';
      }
      return result;
    } catch (error) {
      return { ...result, notice: `Unable to preview this file: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  resolve(file: string): string {
    const resolved = path.resolve(this.root, file);
    const relative = path.relative(this.root, resolved);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Invalid repository path.');
    return resolved;
  }
}
