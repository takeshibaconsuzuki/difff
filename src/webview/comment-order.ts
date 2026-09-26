import type { ReviewComment, ReviewState } from '../model';

function rowPosition(lines: Map<number, number> | undefined, line: number): number {
  const exact = lines?.get(line);
  if (exact !== undefined) return exact;
  let previousLine = 1;
  let previousIndex = 0;
  for (const [number, index] of lines ?? []) {
    if (number > line) return index - (number - line);
    previousLine = number;
    previousIndex = index;
  }
  return previousIndex + line - previousLine;
}

export function orderComments(review: ReviewState, comments: ReviewComment[]): ReviewComment[] {
  const positions = new Map(review.files.map((file, index) => [file.path, {
    index,
    old: new Map<number, number>(),
    new: new Map<number, number>(),
  }]));
  for (const file of review.files) {
    const position = positions.get(file.path)!;
    let index = 0;
    let nextOldLine = 1;
    for (const hunk of file.hunks) {
      const oldStart = hunk.oldStart + (hunk.oldLines ? 0 : 1);
      index += Math.max(0, oldStart - nextOldLine);
      for (const line of hunk.lines) {
        if (line.oldLine) position.old.set(line.oldLine, index);
        if (line.newLine) position.new.set(line.newLine, index);
        index++;
      }
      nextOldLine = oldStart + hunk.oldLines;
    }
  }
  return [...comments].sort((a, b) => {
    const scope = Number(b.scope === review.scope) - Number(a.scope === review.scope);
    if (scope) return scope;
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
    const aFile = positions.get(a.path);
    const bFile = positions.get(b.path);
    const file = (aFile?.index ?? Infinity) - (bFile?.index ?? Infinity);
    if (file) return file;
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    const aRow = a.scope === review.scope ? rowPosition(aFile?.[a.side], a.line) : a.line;
    const bRow = b.scope === review.scope ? rowPosition(bFile?.[b.side], b.line) : b.line;
    return aRow - bRow || Number(a.side === 'new') - Number(b.side === 'new');
  });
}
