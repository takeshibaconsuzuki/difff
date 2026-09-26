import type { ContextGap, DiffLine, Hunk, ReviewFile, Side } from './model';

// The diff library already normalizes empty ranges to their insertion point.
const start = (hunk: Hunk, side: Side): number => side === 'old' ? hunk.oldStart : hunk.newStart;

export function header(hunk: Hunk): Hunk {
  return { ...hunk, header: `@@ −${hunk.oldStart - (hunk.oldLines ? 0 : 1)},${hunk.oldLines} +${hunk.newStart - (hunk.newLines ? 0 : 1)},${hunk.newLines} @@` };
}

export function contextGaps(hunks: Hunk[], oldLength: number): ContextGap[] {
  const gaps: ContextGap[] = [];
  let oldStart = 1;
  let newStart = 1;
  for (let before = 0; before <= hunks.length; before++) {
    const hunk = hunks[before];
    const count = (hunk ? start(hunk, 'old') : oldLength + 1) - oldStart;
    if (count > 0) gaps.push({ id: `${oldStart}:${newStart}:${count}`, before, oldStart, newStart, count });
    if (hunk) {
      oldStart = start(hunk, 'old') + hunk.oldLines;
      newStart = start(hunk, 'new') + hunk.newLines;
    }
  }
  return gaps;
}

function merge(hunks: Hunk[]): Hunk[] {
  const merged: Hunk[] = [];
  for (const hunk of hunks) {
    const previous = merged.at(-1);
    if (previous && start(previous, 'old') + previous.oldLines === start(hunk, 'old') && start(previous, 'new') + previous.newLines === start(hunk, 'new')) {
      merged[merged.length - 1] = header({
        ...previous,
        oldStart: previous.oldLines ? previous.oldStart : hunk.oldStart,
        newStart: previous.newLines ? previous.newStart : hunk.newStart,
        oldLines: previous.oldLines + hunk.oldLines,
        newLines: previous.newLines + hunk.newLines,
        lines: [...previous.lines, ...hunk.lines],
      });
    } else merged.push(hunk);
  }
  return merged;
}

function revealRange(file: ReviewFile, source: string[], gap: ContextGap, offset: number, count: number): ReviewFile {
  const oldStart = gap.oldStart + offset;
  const newStart = gap.newStart + offset;
  const lines: DiffLine[] = source.slice(oldStart - 1, oldStart - 1 + count).map((text, index) => ({ kind: 'context', text, oldLine: oldStart + index, newLine: newStart + index }));
  if (!lines.length) return file;
  const hunks = [...file.hunks];
  hunks.splice(gap.before, 0, header({ header: '', oldStart, newStart, oldLines: lines.length, newLines: lines.length, lines }));
  const joined = merge(hunks);
  return { ...file, hunks: joined, gaps: contextGaps(joined, source.length) };
}

export function expandContext(file: ReviewFile, source: string[], gapId: string, direction: 'up' | 'down', amount = 20): ReviewFile {
  const gap = file.gaps.find(gap => gap.id === gapId);
  if (!gap) return file;
  if (direction === 'up' && gap.before === file.hunks.length || direction === 'down' && gap.before === 0) return file;
  const count = Math.min(amount, gap.count);
  return revealRange(file, source, gap, direction === 'up' ? gap.count - count : 0, count);
}

export function expandAllContext(file: ReviewFile, source: string[]): ReviewFile {
  const hunks: Hunk[] = [];
  const gaps = new Map(file.gaps.map(gap => [gap.before, gap]));
  for (let before = 0; before <= file.hunks.length; before++) {
    const gap = gaps.get(before);
    if (gap) {
      const lines: DiffLine[] = source.slice(gap.oldStart - 1, gap.oldStart - 1 + gap.count).map((text, index) => ({ kind: 'context', text, oldLine: gap.oldStart + index, newLine: gap.newStart + index }));
      if (lines.length) hunks.push(header({ header: '', oldStart: gap.oldStart, newStart: gap.newStart, oldLines: lines.length, newLines: lines.length, lines }));
    }
    const hunk = file.hunks[before];
    if (hunk) hunks.push(hunk);
  }
  const joined = merge(hunks);
  return { ...file, hunks: joined, gaps: contextGaps(joined, source.length) };
}

export function revealContextLine(file: ReviewFile, source: string[], side: Side, line: number): ReviewFile {
  const gap = file.gaps.find(gap => line >= (side === 'old' ? gap.oldStart : gap.newStart) && line < (side === 'old' ? gap.oldStart : gap.newStart) + gap.count);
  if (!gap) return file;
  const offset = Math.max(0, line - (side === 'old' ? gap.oldStart : gap.newStart) - 3);
  return revealRange(file, source, gap, offset, Math.min(7, gap.count - offset));
}
