import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { findAnchor, type DiffLine, type ReviewComment, type Scope, type Side } from '../model';
import { post, type Draft } from './bridge';
import { CommentsPane, Composer, type CommentHandlers, type DraftHandlers } from './comments';
import { DiffFile } from './diff';
import { FilesPane, Toolbar } from './navigation';
import { useReview } from './use-review';
import { useDiffSearch } from './use-search';
import { usePageFocus } from './use-page-focus';
import { captureDiffPosition, focusComposer, revealFileLink, revealInDiff, scrollInPane } from './scroll';
import './review.css';

const noComments: ReviewComment[] = [];

function ReviewApp() {
  const { state, dispatch } = useReview();
  const { review, draft, saving } = state;
  const loading = !!state.loadingReview;
  const busy = state.busy || saving || loading;
  const { repository, scope } = review;
  const diff = useRef<HTMLElement>(null);
  const navigating = useRef(false);
  const deletionAnchor = useRef<{ id: string; restore: () => void } | undefined>(undefined);
  const wrapAnchor = useRef<(() => void) | undefined>(undefined);
  const comments = useRef<HTMLDivElement>(null);
  const queryInput = useRef<HTMLInputElement>(null);
  const fileFilter = useRef<HTMLInputElement>(null);
  const clearDialog = useRef<HTMLDialogElement>(null);
  const search = useDiffSearch(review.files, state.query, state.regex, state.matchCase);
  const focused = usePageFocus();

  useLayoutEffect(() => { document.documentElement.dataset.theme = state.theme; }, [state.theme]);

  useLayoutEffect(() => {
    const anchor = deletionAnchor.current;
    if (!anchor) return;
    anchor.restore();
    if (!review.comments.some(comment => comment.id === anchor.id)) deletionAnchor.current = undefined;
  }, [review.comments, draft]);

  const syncVisibleFile = useCallback(() => {
    const pane = diff.current;
    if (!pane || navigating.current) return;
    const top = pane.getBoundingClientRect().top + parseFloat(getComputedStyle(pane).paddingTop) + 1;
    const cards = [...pane.querySelectorAll<HTMLElement>('.file-card')];
    const active = cards.find(card => card.getBoundingClientRect().bottom > top);
    if (active?.dataset.path) {
      dispatch({ type: 'activeFile', path: active.dataset.path });
      revealFileLink(active.dataset.path);
    }
  }, [dispatch]);

  useLayoutEffect(() => {
    wrapAnchor.current?.();
    wrapAnchor.current = undefined;
    syncVisibleFile();
  }, [state.wordWrap, syncVisibleFile]);

  useEffect(() => {
    const pane = diff.current;
    if (!pane) return;
    let frame = 0;
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; syncVisibleFile(); }); };
    const endNavigation = () => {
      if (navigating.current) { cancelAnimationFrame(frame); frame = 0; }
      navigating.current = false;
    };
    pane.addEventListener('scroll', onScroll, { passive: true });
    pane.addEventListener('scrollend', endNavigation);
    pane.addEventListener('wheel', endNavigation, { passive: true });
    pane.addEventListener('touchstart', endNavigation, { passive: true });
    pane.addEventListener('pointerdown', endNavigation);
    pane.addEventListener('keydown', endNavigation);
    return () => {
      pane.removeEventListener('scroll', onScroll);
      pane.removeEventListener('scrollend', endNavigation);
      pane.removeEventListener('wheel', endNavigation);
      pane.removeEventListener('touchstart', endNavigation);
      pane.removeEventListener('pointerdown', endNavigation);
      pane.removeEventListener('keydown', endNavigation);
      cancelAnimationFrame(frame);
    };
  }, [syncVisibleFile]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.isComposing) return;
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        // VS Code forwards bubbled keys to its shortcuts even when default is prevented.
        event.stopPropagation();
        queryInput.current?.focus({ preventScroll: true });
        queryInput.current?.select();
      }
      if (event.key.toLowerCase() === 'p') {
        event.preventDefault();
        event.stopPropagation();
        dispatch({ type: 'filesOpen', open: true });
        fileFilter.current?.focus({ preventScroll: true });
        fileFilter.current?.select();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); };
  }, [dispatch]);

  useLayoutEffect(() => {
    if (state.filesOpen) { fileFilter.current?.focus({ preventScroll: true }); fileFilter.current?.select(); }
  }, [state.filesOpen]);

  useLayoutEffect(() => {
    if (!state.reveal) return;
    const reveal = state.reveal;
    const row = [...diff.current?.querySelectorAll<HTMLElement>('[data-row]') ?? []].find(node => node.dataset.row === reveal.rowId);
    const inline = [...diff.current?.querySelectorAll<HTMLElement>('.inline-comment') ?? []].find(node => node.dataset.comment === reveal.commentId);
    if (row) {
      navigating.current = false;
      revealInDiff(inline ?? row);
      syncVisibleFile();
    }
    const card = [...comments.current?.querySelectorAll<HTMLElement>('.comment-card') ?? []].find(node => node.dataset.comment === reveal.commentId);
    if (card && comments.current) scrollInPane(comments.current, card, 'nearest', true);
    if (!row) card?.querySelector<HTMLButtonElement>('.comment-jump')?.focus({ preventScroll: true });
  }, [state.reveal, syncVisibleFile]);

  useLayoutEffect(() => {
    const warning = state.draftWarning;
    if (!warning || !comments.current) return;
    const card = [...comments.current.querySelectorAll<HTMLElement>('.comment-card')].find(node => node.dataset.comment === warning.commentId);
    if (card) scrollInPane(comments.current, card, 'nearest', true);
  }, [state.draftWarning]);

  useLayoutEffect(() => {
    if (!search.scrollRequest) return;
    navigating.current = false;
    const mark = diff.current?.querySelector<HTMLElement>(`mark[data-match="${search.scrollRequest.index}"]`);
    if (mark) {
      revealInDiff(mark);
      const table = mark.closest<HTMLElement>('.code-table');
      if (table) {
        const bounds = table.getBoundingClientRect();
        const match = mark.getBoundingClientRect();
        if (match.left < bounds.left || match.right > bounds.right) table.scrollTo({ left: table.scrollLeft + (match.left + match.right - bounds.left - bounds.right) / 2, behavior: 'smooth' });
      }
    }
  }, [search.scrollRequest]);

  const jumpToFile = useCallback((path: string) => {
    navigating.current = true;
    dispatch({ type: 'selectFile', path });
    revealFileLink(path);
    const file = [...diff.current?.querySelectorAll<HTMLElement>('.file-card') ?? []].find(node => node.dataset.path === path);
    if (file && diff.current) scrollInPane(diff.current, file, 'start');
  }, [dispatch]);

  const startDraft = useCallback((path: string, row: DiffLine, side: Side) => {
    if (saving) return;
    const line = side === 'old' ? row.oldLine : row.newLine;
    if (!line) return;
    diff.current?.querySelector('textarea')?.focus({ preventScroll: true });
    dispatch({ type: 'beginDraft', draft: { repository, scope, path, line, side, code: row.text, body: '' } });
  }, [dispatch, repository, scope, saving]);

  const draftHandlers = useMemo<DraftHandlers>(() => ({
    change: body => { dispatch({ type: 'draftBody', body }); },
    cancel: () => { dispatch({ type: 'cancelDraft' }); },
    save: (value: Draft) => {
      if (!value.body.trim() || busy) return;
      dispatch({ type: 'startSaving' });
      if (value.id) post({ type: 'edit', id: value.id, body: value.body });
      else post({ type: 'comment', repository: value.repository, path: value.path, line: value.line, side: value.side, code: value.code, body: value.body, scope: value.scope });
    },
  }), [dispatch, busy]);

  const commentHandlers = useMemo<CommentHandlers>(() => ({
    disabled: saving,
    edit: comment => {
      if (saving) return;
      const composer = diff.current?.querySelector<HTMLElement>('.composer');
      if (draft?.id === comment.id && composer) { focusComposer(composer); return; }
      dispatch({ type: 'beginDraft', draft: { ...comment } });
    },
    remove: id => {
      if (saving) return;
      if (diff.current) deletionAnchor.current = { id, restore: captureDiffPosition(diff.current) };
      dispatch({ type: 'deleteDraft', id });
      post({ type: 'delete', id });
    },
    show: id => { dispatch({ type: 'showComment', id }); },
  }), [dispatch, draft, saving]);

  const commentsByFile = useMemo(() => {
    const grouped = new Map<string, ReviewComment[]>();
    for (const comment of review.comments) {
      if (comment.scope !== review.scope) continue;
      const list = grouped.get(comment.path) ?? [];
      list.push(comment);
      grouped.set(comment.path, list);
    }
    return grouped;
  }, [review.comments, review.scope]);

  const draftFile = draft && draft.repository === repository && draft.scope === scope ? review.files.find(file => file.path === draft.path && findAnchor(file, draft.side, draft.line)?.text === draft.code) : undefined;
  const searchCount = state.query ? `${search.result.matches.length ? search.index + 1 : 0}/${search.result.matches.length}${search.result.capped ? '+' : ''}` : '';
  const changeScope = (scope: Scope) => {
    if (busy || scope === review.scope) return;
    if (draft) { dispatch({ type: 'requireDraft', text: 'Save or cancel your draft before changing scope.' }); return; }
    dispatch({ type: 'scope', scope });
    post({ type: 'scope', scope });
  };

  return <>
    <Toolbar review={review} busy={busy} query={state.query} regex={state.regex} matchCase={state.matchCase} commentsOpen={state.commentsOpen} filesOpen={state.filesOpen} theme={state.theme} focused={focused} onTheme={() => { dispatch({ type: 'toggleTheme' }); }}
      wordWrap={state.wordWrap} onWordWrap={() => {
        if (diff.current) wrapAnchor.current = captureDiffPosition(diff.current);
        dispatch({ type: 'toggleWordWrap' });
      }}
      searchCount={searchCount} hasMatches={!!search.result.matches.length} queryRef={queryInput} onScope={changeScope}
      onRepository={root => {
        if (busy || root === repository) return;
        if (draft) { dispatch({ type: 'requireDraft', text: 'Save or cancel your draft before changing repositories.' }); return; }
        dispatch({ type: 'repository', root });
        post({ type: 'repository', root });
      }} onQuery={query => { dispatch({ type: 'query', query }); }} onRegex={() => { dispatch({ type: 'regex' }); }} onMatchCase={() => { dispatch({ type: 'matchCase' }); }}
      onMatch={search.move} onRefresh={() => post({ type: 'refresh' })} onCopy={() => post({ type: 'copy' })} onComments={() => { dispatch({ type: 'toggleComments' }); }}
      onFiles={() => { dispatch({ type: 'filesOpen', open: !state.filesOpen }); }} onEscape={() => diff.current?.focus()} />
    <div id="search-error" role="status">{search.result.error}</div>
    <div id="workspace" className={`workspace${state.commentsOpen ? '' : ' hide-comments'}${state.filesOpen ? ' show-files' : ''}`}>
      <FilesPane key={JSON.stringify([repository, scope])} review={review} activePath={state.activePath} jump={jumpToFile} filterRef={fileFilter} />
      <main id="diff" ref={diff} className={state.wordWrap ? 'word-wrap' : undefined} aria-label="Diff review" tabIndex={-1} aria-busy={busy}>
        {draft && !draftFile && <Composer draft={draft} busy={busy} saving={saving} handlers={draftHandlers} />}
        {!loading && (review.error || !review.files.length) && <div className="diff-empty"><p>{review.error ?? `No ${scope} changes.`}</p></div>}
        {review.files.map(file => <DiffFile key={JSON.stringify([repository, scope, file.path])} file={file} comments={commentsByFile.get(file.path) ?? noComments}
          draft={draftFile === file ? draft : undefined} busy={busy} saving={saving} startDraft={startDraft} draftHandlers={draftHandlers} commentHandlers={commentHandlers}
          matches={search.byRow} activeMatch={search.index} flashRow={state.reveal?.rowId} pulseSequence={state.reveal?.sequence ?? 0} />)}
      </main>
      <CommentsPane review={review} busy={busy} loading={loading} handlers={commentHandlers} paneRef={comments} flashId={state.reveal?.commentId} pulseSequence={state.reveal?.sequence ?? 0} warning={state.draftWarning} draft={draft}
        resumeDraft={() => { const composer = diff.current?.querySelector<HTMLElement>('.composer'); if (composer) focusComposer(composer); }} cancelDraft={draftHandlers.cancel}
        clear={() => { if (!busy) clearDialog.current?.showModal(); }} jump={id => {
        if (busy) return;
        const composer = diff.current?.querySelector<HTMLElement>('.composer');
        if (draft?.id === id && composer) { focusComposer(composer); return; }
        if (draft) { dispatch({ type: 'requireDraft', text: 'Save or cancel your draft before jumping to another comment.' }); return; }
        const comment = review.comments.find(comment => comment.id === id);
        if (comment && comment.scope !== scope) dispatch({ type: 'scope', scope: comment.scope });
        post({ type: 'jump', id });
      }} />
    </div>
    <div id="notice" role="status" aria-live="polite" hidden={!state.notice} className={state.notice?.error ? 'error' : ''}>{state.notice?.text}</div>
    <dialog id="clear-dialog" ref={clearDialog} onClose={() => {
      if (clearDialog.current?.returnValue !== 'clear') return;
      if (draft?.id) dispatch({ type: 'cancelDraft' });
      post({ type: 'clear' });
    }}>
      <form method="dialog"><h2>Clear all comments?</h2><p>This removes every review comment in this repository, across all three scopes.</p>
        <div className="dialog-actions"><button value="cancel">Keep comments</button><button value="clear" className="danger">Clear all comments</button></div>
      </form>
    </dialog>
  </>;
}

const root = document.getElementById('app');
if (!root) throw new Error('Missing review root.');
createRoot(root).render(<ReviewApp />);
