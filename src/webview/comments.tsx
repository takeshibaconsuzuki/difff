import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { findAnchor, sourceLabel, type ReviewComment, type ReviewState } from '../model';
import type { Draft } from './bridge';
import { Button, pulseClass } from './ui';
import { focusComposer } from './scroll';
import { orderComments } from './comment-order';

export interface CommentHandlers {
  disabled: boolean;
  edit: (comment: ReviewComment) => void;
  remove: (id: string) => void;
  show: (id: string) => void;
}

export interface DraftHandlers {
  change: (body: string) => void;
  cancel: () => void;
  save: (draft: Draft) => void;
}

export function CommentActions({ comment, handlers, focus = false }: { comment: ReviewComment; handlers: CommentHandlers; focus?: boolean }) {
  return <div className="comment-actions">
    <Button title="Edit comment" className="text-button" disabled={handlers.disabled} onClick={() => handlers.edit(comment)}>Edit</Button>
    <Button title="Delete comment" className="text-button delete-comment" disabled={handlers.disabled} onClick={() => handlers.remove(comment.id)}>Delete</Button>
    {focus && <Button title="Focus comment in panel" className="text-button" onClick={() => handlers.show(comment.id)}>Focus</Button>}
  </div>;
}

export function InlineComment({ comment, handlers }: { comment: ReviewComment; handlers: CommentHandlers }) {
  return <article className="inline-comment" data-comment={comment.id}>
    <p className="inline-comment-body">{comment.body}</p>
    <CommentActions comment={comment} handlers={handlers} focus />
  </article>;
}

export function CommentsPane({ review, busy, loading, handlers, jump, clear, flashId, pulseSequence, warning, draft, resumeDraft, cancelDraft, paneRef }: {
  review: ReviewState;
  busy: boolean;
  loading: boolean;
  handlers: CommentHandlers;
  jump: (id: string) => void;
  clear: () => void;
  flashId?: string;
  pulseSequence: number;
  warning?: { commentId: string; sequence: number };
  draft?: Draft;
  resumeDraft: () => void;
  cancelDraft: () => void;
  paneRef: RefObject<HTMLDivElement | null>;
}) {
  const comments = useMemo(() => orderComments(review, draft && !draft.id && draft.repository === review.repository
    ? [...review.comments, { ...draft, id: 'draft', createdAt: '' }]
    : review.comments), [review, draft]);
  return <aside id="comments-pane" className="comments-pane" aria-label="Review comments">
    <div className="pane-heading">COMMENTS <Button id="clear" className="text-button" disabled={busy || !review.comments.length} onClick={clear}>Clear all</Button></div>
    <div id="comments" ref={paneRef}>
      {!loading && !comments.length && <p className="comments-empty">No comments.</p>}
      {comments.map(comment => {
        const file = review.files.find(file => file.path === comment.path);
        const outdated = comment.scope === review.scope && findAnchor(file, comment.side, comment.line)?.text !== comment.code;
        const isDraft = comment.id === 'draft';
        const pulse = warning?.commentId === comment.id ? ` draft-warning ${pulseClass(warning.sequence)}` : flashId === comment.id ? ` ${pulseClass(pulseSequence)}` : '';
        return <article className={`comment-card${isDraft ? ' draft-card' : ''}${pulse}`} data-comment={comment.id} key={comment.id}>
          <Button className="comment-jump" disabled={handlers.disabled} title={isDraft ? 'Return to draft' : 'Jump to comment'} onClick={() => isDraft ? resumeDraft() : jump(comment.id)}>
            <span className="comment-location">{comment.path}:{comment.line}</span>
            <span className="comment-meta">{comment.scope} · {sourceLabel(comment)}{isDraft && ' · Draft'}{outdated && <span className="outdated"> · line changed or hidden</span>}</span>
            <span className="comment-body">{comment.body || (isDraft ? 'Empty draft' : '')}</span>
          </Button>
          {isDraft ? <div className="comment-actions"><Button title="Resume draft" className="text-button" disabled={handlers.disabled} onClick={resumeDraft}>Edit</Button><Button title="Cancel draft" className="text-button" disabled={handlers.disabled} onClick={cancelDraft}>Cancel</Button></div> : <CommentActions comment={comment} handlers={handlers} />}
        </article>;
      })}
    </div>
  </aside>;
}

export function Composer({ draft, handlers, busy, saving }: { draft: Draft; handlers: DraftHandlers; busy: boolean; saving: boolean }) {
  const composer = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (composer.current) focusComposer(composer.current);
  }, [draft.id, draft.path, draft.line, draft.scope]);
  return <div className="composer" ref={composer}>
    <div className="composer-heading">{draft.path}:{draft.line} · {sourceLabel(draft)}</div>
    <textarea ref={textarea} disabled={saving} placeholder="Comment…" aria-label={draft.id ? 'Edit comment' : 'Write a comment'} maxLength={20000} rows={3}
      value={draft.body} onChange={event => handlers.change(event.target.value)} onKeyDown={event => {
        if (saving) return;
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (!busy) handlers.save(draft); }
        if (event.key === 'Escape') { event.preventDefault(); handlers.cancel(); }
      }} />
    <div className="composer-actions">
      <Button title="Cancel comment" disabled={saving} onClick={handlers.cancel}>Cancel</Button>
      <Button title="Save comment" className="primary save-comment" disabled={busy || !draft.body.trim()} onClick={() => handlers.save(draft)}>Save</Button>
    </div>
  </div>;
}
