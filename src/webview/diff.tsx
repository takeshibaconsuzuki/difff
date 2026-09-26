import { Fragment, memo, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import type { ContextGap, DiffLine, ReviewComment, ReviewFile, Side } from '../model';
import { post, rowId, type Draft } from './bridge';
import { Composer, InlineComment, type CommentHandlers, type DraftHandlers } from './comments';
import { Button, FileStatus, pulseClass } from './ui';
import type { IndexedMatch } from './use-search';

function HighlightedLine({ text, matches, activeIndex }: { text: string; matches?: IndexedMatch[]; activeIndex: number }) {
  const content: ReactNode[] = [];
  let start = 0;
  for (const match of matches ?? []) {
    content.push(text.slice(start, match.start));
    content.push(<mark key={match.index} data-match={match.index} className={match.index === activeIndex ? 'active-mark' : ''}>{text.slice(match.start, match.end) || '▏'}</mark>);
    start = match.end;
  }
  content.push(text.slice(start) || (start === 0 ? ' ' : ''));
  return <code className="line-code">{content}</code>;
}

function Gap({ file, gap, busy }: { file: ReviewFile; gap: ContextGap; busy: boolean }) {
  const amount = Math.min(20, gap.count);
  const lines = amount === 1 ? 'line' : 'lines';
  const show = (direction: 'up' | 'down') => post({ type: 'expand', path: file.path, snapshot: file.snapshot, gap: gap.id, direction });
  const middle = gap.before > 0 && gap.before < file.hunks.length;
  return <div className="context-gap" data-gap={gap.id}>
    {middle && gap.count <= 20 ? <Button className="expand text-button" title={`Show ${amount} hidden ${lines}`} disabled={busy} onClick={() => show('down')}>Show {amount} {lines}</Button> : <>
      {gap.before > 0 && <Button className="expand text-button" title={`Show ${amount} ${lines} below`} disabled={busy} onClick={() => show('down')}>↓ +{amount} context</Button>}
      {gap.before < file.hunks.length && <Button className="expand text-button" title={`Show ${amount} ${lines} above`} disabled={busy} onClick={() => show('up')}>↑ +{amount} context</Button>}
    </>}
  </div>;
}

export const DiffFile = memo(function DiffFile({ file, comments, draft, busy, saving, startDraft, draftHandlers, commentHandlers, matches, activeMatch, flashRow, pulseSequence }: {
  file: ReviewFile;
  comments: ReviewComment[];
  draft?: Draft;
  busy: boolean;
  saving: boolean;
  startDraft: (path: string, row: DiffLine, side: Side) => void;
  draftHandlers: DraftHandlers;
  commentHandlers: CommentHandlers;
  matches: Map<string, IndexedMatch[]>;
  activeMatch: number;
  flashRow?: string;
  pulseSequence: number;
}) {
  const card = useRef<HTMLElement>(null);
  const expansionAnchor = useRef<{ row: string; top: number; snapshot: string } | undefined>(undefined);
  useLayoutEffect(() => {
    const anchor = expansionAnchor.current;
    if (!anchor) return;
    expansionAnchor.current = undefined;
    if (anchor.snapshot !== file.snapshot) return;
    const row = [...card.current?.querySelectorAll<HTMLElement>('[data-row]') ?? []].find(node => node.dataset.row === anchor.row);
    const scroller = card.current?.closest('#diff');
    if (row && scroller) scroller.scrollTop += row.getBoundingClientRect().top - anchor.top;
  }, [file.hunks, file.snapshot]);
  const expandAll = () => {
    const row = [...card.current?.querySelectorAll<HTMLElement>('[data-row]') ?? []].at(-1);
    if (row?.dataset.row) expansionAnchor.current = { row: row.dataset.row, top: row.getBoundingClientRect().top, snapshot: file.snapshot };
    post({ type: 'expandAll', path: file.path, snapshot: file.snapshot });
  };
  const commentsByLine = useMemo(() => {
    const grouped = new Map<string, ReviewComment[]>();
    for (const comment of comments) {
      const key = JSON.stringify([comment.side, comment.line, comment.code]);
      const list = grouped.get(key) ?? [];
      list.push(comment);
      grouped.set(key, list);
    }
    return grouped;
  }, [comments]);
  return <section className="file-card" data-path={file.path} ref={card}>
    <header className="file-header">
      <div className="file-title"><FileStatus status={file.status} /><h2>{file.path}</h2></div>
      <div className="file-actions">
        <span className="added-stat">+{file.additions}</span><span className="deleted-stat">−{file.deletions}</span>
        {file.status !== 'D' && <Button title="Open file in editor" className="open-file" onClick={() => post({ type: 'open', path: file.path, line: 1 })}>↗</Button>}
      </div>
    </header>
    {file.notice && <p className="file-notice">{file.notice}</p>}
    <div className="code-table">
      <div className="code-content">
      {file.hunks.flatMap((hunk, hunkIndex) => [
        ...file.gaps.filter(gap => gap.before === hunkIndex).map(gap => <Gap key={`gap-${gap.id}`} file={file} gap={gap} busy={busy} />),
        <div className="hunk-header" key={`hunk-${hunkIndex}`}><span>{hunk.header}</span></div>,
        ...hunk.lines.map((line, lineIndex) => {
          if (line.kind === 'note') return <div className="diff-line note" key={`note-${hunkIndex}-${lineIndex}`}><span className="line-note">{line.text}</span></div>;
          const id = rowId(file.path, line);
          const lineMatches = matches.get(id);
          const current = lineMatches?.some(match => match.index === activeMatch);
          const lineComments = [
            ...(commentsByLine.get(JSON.stringify(['old', line.oldLine, line.text])) ?? []),
            ...(commentsByLine.get(JSON.stringify(['new', line.newLine, line.text])) ?? []),
          ];
          const hasDraft = draft && (draft.side === 'old' ? line.oldLine : line.newLine) === draft.line && draft.code === line.text;
          return <Fragment key={id}>
            <div className={`diff-line ${line.kind}${current ? ' current-match' : ''}${flashRow === id ? ` ${pulseClass(pulseSequence)}` : ''}`} data-row={id}>
              <Button title={`Comment on ${file.path}:${line.newLine ?? line.oldLine ?? 1}`} className="add-comment" disabled={saving} onClick={() => startDraft(file.path, line, line.newLine ? 'new' : 'old')}>+</Button>
              <span className={`line-number${line.oldLine ? ' old-number' : ''}`}>{line.oldLine}</span>
              <span className="line-number">{line.newLine}</span>
              <span className="line-sign">{line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ''}</span>
              <HighlightedLine text={line.text} matches={lineMatches} activeIndex={activeMatch} />
            </div>
            {lineComments.map(comment => <InlineComment key={comment.id} comment={comment} handlers={commentHandlers} />)}
            {hasDraft && <Composer key={draft.id ?? 'new-draft'} draft={draft} busy={busy} saving={saving} handlers={draftHandlers} />}
          </Fragment>;
        }),
      ])}
      {file.gaps.filter(gap => gap.before === file.hunks.length).map(gap => <Gap key={`gap-${gap.id}`} file={file} gap={gap} busy={busy} />)}
      </div>
    </div>
    {!!file.gaps.length && <div className="file-bottom">
      <Button title="Expand all context" className="expand text-button" disabled={busy} onClick={expandAll}>Expand all</Button>
    </div>}
  </section>;
});
