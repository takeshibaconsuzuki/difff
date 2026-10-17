import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { formatPatch, parsePatch, reversePatch, structuredPatch, type StructuredPatchHunk } from 'diff';
import { simpleGit, type SimpleGit } from 'simple-git';
import { WORKING, INDEX, type DiffLine, type Hunk, type ReviewFile, type Side } from './model';
import { contextGaps, expandAllContext, expandContext, header, revealContextLine, type ContextSource } from './context';
import { withUntrackedComparison } from './git-renames';

const MAX_BYTES = 2 * 1024 * 1024;

function changedPaths(names: string): Map<string, Pick<ReviewFile, 'status' | 'originalPath'>> {
  const entries = names.split('\0');
  const paths = new Map<string, Pick<ReviewFile, 'status' | 'originalPath'>>();
  for (let i = 0; i + 1 < entries.length;) {
    const status = entries[i++]?.[0] ?? 'M';
    const firstPath = entries[i++];
    // Rename records contain a similarity score and two NUL-delimited paths.
    const originalPath = status === 'R' ? firstPath : undefined;
    const file = status === 'R' ? entries[i++] : firstPath;
    // Git can report both U and M for the same conflicted path.
    if (file && paths.get(file)?.status !== 'U') paths.set(file, { status, originalPath });
  }
  return paths;
}

const nameStatusArgs = ['--name-status', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', '--'];

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
  private readonly sources = new Map<string, ContextSource>();

  constructor(readonly root: string, private readonly ignoreWhitespace = true) {
    this.git = simpleGit({ baseDir: root, maxConcurrentProcesses: 4, timeout: { block: 30000 }, allowEnvironment: ['GIT_LITERAL_PATHSPECS', 'GIT_OPTIONAL_LOCKS'] });
    // Paths are passed as separate argv entries; literal pathspecs also handle [] and leading colons.
    this.git.env('GIT_LITERAL_PATHSPECS', '1').env('GIT_OPTIONAL_LOCKS', '0');
  }

  async branch(): Promise<string> {
    return (await this.git.raw(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => 'detached HEAD')).trim();
  }

  private async commit(ref: string): Promise<string> {
    if (!ref || ref.startsWith('-') || ref.includes('\0')) throw new Error('Enter a Git commit ref.');
    return (await this.git.raw(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).catch(() => { throw new Error(`Cannot resolve ref "${ref}" to a commit.`); })).trim();
  }

  private async headOrEmptyTree(): Promise<string> {
    const head = await this.git.raw(['rev-parse', '--verify', 'HEAD']).catch(() => '');
    // The canonical empty tree does not require writing an object or opening a stdin stream.
    const format = head.trim() ? '' : (await this.git.raw(['rev-parse', '--show-object-format'])).trim();
    return head.trim() || createHash(format === 'sha256' ? 'sha256' : 'sha1').update('tree 0\0').digest('hex');
  }

  private async mergeBase(baseRef: string, endRef: string): Promise<[string, string]> {
    const [start, finish] = await Promise.all([this.commit(baseRef), this.commit(endRef)]);
    const bases = (await this.git.raw(['merge-base', '--all', start, finish]).catch(() => { throw new Error(`No merge base found for "${baseRef}" and "${endRef}".`); })).trim().split('\n');
    if (bases.length !== 1) throw new Error('Multiple merge bases found. Choose a more specific base ref.');
    return [bases[0]!, finish];
  }

  private async baseArgs(baseRef: string, endRef: string): Promise<string[]> {
    if (baseRef === INDEX) return [];
    if (endRef === INDEX || endRef === WORKING) {
      // Local endpoints build on HEAD, so other refs start where they meet HEAD's history.
      const start = baseRef === 'HEAD' ? await this.headOrEmptyTree() : (await this.mergeBase(baseRef, 'HEAD'))[0];
      return endRef === INDEX ? ['--cached', start] : [start];
    }
    return this.mergeBase(baseRef, endRef);
  }

  async files(baseRef = 'HEAD', endRef = WORKING): Promise<ReviewFile[]> {
    if (baseRef === endRef && (baseRef === INDEX || baseRef === WORKING)) return [];
    const reverse = baseRef === WORKING || baseRef === INDEX && endRef !== WORKING;
    const loaded = await this.loadFiles(reverse ? endRef : baseRef, reverse ? baseRef : endRef, reverse);
    const files = reverse ? loaded.map(file => this.reverse(file)).sort((a, b) => a.path.localeCompare(b.path)) : loaded;
    for (let i = 0; i < files.length; i += 4) {
      await Promise.all(files.slice(i, i + 4).map(async file => { file.canOpen = await this.canOpen(file.path); }));
    }
    return files;
  }

  private async canOpen(file: string): Promise<boolean> {
    return stat(this.resolve(file)).then(info => info.isFile()).catch(() => false);
  }

  private async loadFiles(baseRef: string, endRef: string, reverse: boolean): Promise<ReviewFile[]> {
    const base = await this.baseArgs(baseRef, endRef);
    const paths = changedPaths(await this.git.raw(['diff', ...base, ...nameStatusArgs]));
    const recreated = new Set<string>();
    const renamed = new Map<string, ReviewFile>();
    if (endRef === WORKING) {
      const untracked = await this.git.raw(['ls-files', '--others', '--exclude-standard', '-z']);
      for (const file of untracked.split('\0')) {
        if (!file) continue;
        if (baseRef !== INDEX && paths.get(file)?.status === 'D') {
          paths.set(file, { status: 'M' });
          recreated.add(file);
        } else if (!paths.has(file)) paths.set(file, { status: '?' });
      }
      if (reverse) {
        // A reused rename source would become both a rename destination and a
        // deletion when reversed. Compare those paths independently instead.
        for (const [file, change] of paths) {
          if (!change.originalPath || paths.get(change.originalPath)?.status !== '?') continue;
          paths.set(file, { status: 'A' });
          paths.set(change.originalPath, { status: 'M' });
          recreated.add(change.originalPath);
        }
      }
      const deleted = new Set([...paths].filter(([, change]) => change.status === 'D').map(([file]) => file));
      const candidates = [...paths].filter(([, change]) => change.status === '?').map(([file]) => file);
      const detected = await withUntrackedComparison(this.git, this.root, base, deleted, candidates, async (comparison, tree) => {
        const changes = changedPaths(await comparison.raw(['diff', tree, ...nameStatusArgs]));
        const files: ReviewFile[] = [];
        for (const [file, { status, originalPath }] of changes) {
          if (status !== 'R' || !originalPath) continue;
          const patch = await this.patch(file, [tree], originalPath, comparison);
          const preview = await this.file(file, status, base, false, originalPath, patch);
          if (preview) files.push(preview);
        }
        return files;
      }).catch(() => {
        // Rename detection is optional: filters, I/O errors, or timeouts must not hide ordinary changes.
        return [];
      });
      for (const file of detected) {
        if (file.originalPath) paths.delete(file.originalPath);
        paths.set(file.path, file);
        renamed.set(file.path, file);
      }
    }
    const files: ReviewFile[] = [];
    // Keep file reads and patch parsing bounded even in a very large worktree.
    const pending = [...paths.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (let i = 0; i < pending.length; i += 4) {
      const batch = await Promise.all(pending.slice(i, i + 4).map(async ([file, { status, originalPath }]) => renamed.get(file) ?? this.file(file, status, base, recreated.has(file), originalPath)));
      files.push(...batch.filter((file): file is ReviewFile => file !== undefined));
    }
    return files;
  }

  private reverse(file: ReviewFile): ReviewFile {
    const source = this.sources.get(file.snapshot);
    const reversed = reversePatch({ oldFileName: file.originalPath ?? file.path, newFileName: file.path, oldHeader: '', newHeader: '', hunks: file.hunks.map(hunk => ({
      oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines,
      lines: hunk.lines.map(line => line.kind === 'note' ? line.text : `${line.kind === 'add' ? '+' : line.kind === 'delete' ? '-' : ' '}${line.text}`),
    })) });
    const hunks = reversed.hunks.map(toHunk);
    // Ignored whitespace can leave a different spelling on each side of a context row.
    const context = new Map(file.hunks.flatMap(hunk => hunk.lines.filter(line => line.kind === 'context').map(line => [line.oldLine, line])));
    for (const hunk of hunks) for (const line of hunk.lines) {
      const original = line.kind === 'context' ? context.get(line.newLine) : undefined;
      if (original?.oldText !== undefined) { line.oldText = line.text; line.text = original.oldText; }
    }
    const result: ReviewFile = {
      ...file, path: file.originalPath ?? file.path, originalPath: file.originalPath ? file.path : undefined,
      status: file.status === 'A' || file.status === '?' ? 'D' : file.status === 'D' ? 'A' : file.status,
      additions: file.deletions, deletions: file.additions, hunks,
      gaps: file.gaps.map(gap => ({ ...gap, id: `${gap.newStart}:${gap.oldStart}:${gap.count}`, oldStart: gap.newStart, newStart: gap.oldStart })),
    };
    if (source) {
      const old: string[] = [];
      for (const hunk of expandAllContext(file, source).hunks) for (const line of hunk.lines) if (line.newLine !== undefined) old[line.newLine - 1] = line.text;
      this.sources.set(file.snapshot, { old, new: source.old });
    }
    return result;
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

  private async patch(file: string, base: string[], originalPath?: string, git = this.git, context = 3): Promise<string> {
    let revisions = base;
    let paths = [file];
    if (originalPath) {
      const revision = base.length === 0 ? ':' : base[0] === '--cached' ? `${base[1] ?? 'HEAD'}:` : `${base[0] ?? 'HEAD'}:`;
      const source = `${revision}${originalPath}`;
      const type = (await git.raw(['cat-file', '-t', source]).catch(() => '')).trim();
      if (type === 'blob') {
        // Rename detection has already selected the pair. Use those exact blobs
        // for both previews and context, or compare the source to the working file.
        const destination = base[0] === '--cached' ? `:${file}` : base.length === 2 ? `${base[1]}:${file}` : undefined;
        revisions = destination ? [source, destination] : [source];
        if (destination) paths = [];
      } else {
        // Gitlink objects need not exist in the parent repository. Read their
        // pointer, and let Git report the destination (including working dirt).
        const entry = revision === ':'
          ? await git.raw(['ls-files', '--stage', '-z', '--', originalPath])
          : await git.raw(['ls-tree', '-z', revision.slice(0, -1), '--', originalPath]);
        const record = entry.split('\0').find(record => record.slice(record.indexOf('\t') + 1) === originalPath);
        if (!record?.startsWith('160000 ')) throw new Error('Rename changed while loading. Refresh to review it.');
        const object = record.split('\t')[0]!.split(' ')[revision === ':' ? 1 : 2]!;
        const destination = await this.patch(file, base, undefined, git, context);
        const part = parsePatch(destination).find(part => part.newFileName === `b/${file}`);
        const pointer = part?.hunks.flatMap(hunk => hunk.lines).find(line => line.startsWith('+Subproject commit '));
        if (!pointer) throw new Error('Rename changed while loading. Refresh to review it.');
        return formatPatch(structuredPatch(`a/${originalPath}`, `b/${file}`, `Subproject commit ${object}\n`, `${pointer.slice(1)}\n`, '', '', { context }));
      }
    }
    // Preserve the context prefix on blank lines so parsing advances both line counters.
    return git.raw(['-c', 'diff.suppressBlankEmpty=false', 'diff', ...revisions, '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short', `--unified=${context}`, ...(this.ignoreWhitespace ? ['--ignore-all-space'] : []), '--', ...paths]);
  }

  private async file(file: string, status: string, base: string[], recreated = false, originalPath?: string, renamePatch?: string): Promise<ReviewFile | undefined> {
    const result: ReviewFile = { path: file, originalPath, canOpen: false, status, additions: 0, deletions: 0, hunks: [], snapshot: randomUUID(), gaps: [] };
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
          // Compare the base blob directly with the working file so Git applies its attributes and clean filters.
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
        const patch = renamePatch ?? await this.patch(file, base, originalPath);
        if (!patch && status === 'M' && !originalPath) return undefined;
        if (Buffer.byteLength(patch) > MAX_BYTES) return { ...result, notice: 'Diff exceeds the 2 MB preview limit. Open it in the editor to review.' };
        // Validate that the patch still belongs to the detected rename pair.
        const parts = parsePatch(patch).filter(part => !originalPath || part.oldFileName === `a/${originalPath}` && part.newFileName === `b/${file}`);
        if (originalPath && patch && !parts.length) return { ...result, notice: 'Rename changed while loading. Refresh to review it.' };
        hunks = parts.flatMap(part => part.hunks);
        if (!hunks.length) result.notice = parts.some(part => part.isBinary) ? 'Binary file — no text preview.' : originalPath ? 'File renamed without text changes.' : 'File metadata changed, or no text changes remain.';
      }
      result.hunks = hunks.map(toHunk);
      for (const hunk of result.hunks) for (const line of hunk.lines) {
        if (line.kind === 'add') result.additions++;
        if (line.kind === 'delete') result.deletions++;
      }
      if (status === 'U') result.notice = 'Unresolved merge conflict. Resolve the conflict in the editor before completing your review.';
      else if (status !== 'A' && status !== '?' && status !== 'T' && result.hunks.length && !result.hunks.some(hunk => hunk.lines.some(line => line.text.startsWith('Subproject commit ')))) {
        const revision = base.length === 0 ? ':' : base[0] === '--cached' ? `${base[1] ?? 'HEAD'}:` : `${base[0] ?? 'HEAD'}:`;
        original ??= await this.git.show([`${revision}${originalPath ?? file}`]);
        if (Buffer.byteLength(original) <= MAX_BYTES) {
          const source = original === '' ? [] : original.split('\n');
          if (source.at(-1) === '') source.pop();
          const normalized = source.map(line => line.replace(/\r$/, ''));
          // Git emits the new spelling of context when -w matches differently spaced lines.
          const matches = result.hunks.every(hunk => hunk.lines.every(line => {
            if (line.oldLine === undefined) return true;
            const oldText = normalized[line.oldLine - 1];
            if (oldText === line.text) return true;
            if (!this.ignoreWhitespace || line.kind !== 'context' || oldText === undefined || oldText.replace(/[ \t\r\v\f]/g, '') !== line.text.replace(/[ \t\r\v\f]/g, '')) return false;
            line.oldText = oldText;
            return true;
          }));
          if (matches) {
            const gaps = contextGaps(result.hunks, normalized.length);
            let updated: string[] | undefined;
            if (this.ignoreWhitespace && gaps.length) {
              updated = [];
              // Read expanded context through Git as well, preserving clean filters and attributes.
              const contextBase = recreated ? [`${base[0] ?? 'HEAD'}:${file}`] : base;
              const fullPatch = await this.patch(file, contextBase, originalPath, this.git, normalized.length);
              if (Buffer.byteLength(fullPatch) > MAX_BYTES) {
                return { ...result, notice: 'Additional context exceeds the 2 MB source limit. Open the file to see more.' };
              }
              const fullHunks = parsePatch(fullPatch).flatMap(part => part.hunks).map(toHunk);
              for (const hunk of fullHunks) for (const line of hunk.lines) if (line.newLine !== undefined) updated[line.newLine - 1] = line.text;
              const newSource = updated;
              // More context can expose an unchanged EOF note; retain only notes attached to edits.
              const changes = (hunks: Hunk[]) => JSON.stringify(hunks.flatMap(hunk => hunk.lines.filter((line, index, lines) =>
                line.kind === 'add' || line.kind === 'delete'
                || line.kind === 'note' && (lines[index - 1]?.kind === 'add' || lines[index - 1]?.kind === 'delete'))));
              const stable = fullHunks.length === 1 && fullHunks[0]?.oldStart === 1 && fullHunks[0].oldLines === normalized.length
                && changes(fullHunks) === changes(result.hunks)
                && result.hunks.every(hunk => hunk.lines.every(line => line.newLine === undefined || newSource[line.newLine - 1] === line.text));
              if (!stable) {
                return { ...result, notice: 'Source changed while loading. Refresh to expand context.' };
              }
            }
            result.gaps = gaps;
            this.sources.set(result.snapshot, { old: normalized, new: updated });
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
