import { useEffect, useReducer } from 'react';
import { findAnchor, type HostMessage, type ReviewState } from '../model';
import { initialLocalState, persist, post, rowId, type Draft } from './bridge';

interface UIState {
  review: ReviewState;
  busy: boolean;
  saving: boolean;
  loadingReview?: Pick<ReviewState, 'repository' | 'scope'>;
  draft?: Draft;
  activePath: string;
  filesOpen: boolean;
  commentsOpen: boolean;
  query: string;
  regex: boolean;
  matchCase: boolean;
  wordWrap: boolean;
  theme: 'light' | 'dark';
  notice?: { text: string; error?: boolean };
  pulseSequence: number;
  reveal?: { commentId: string; rowId?: string; sequence: number };
  draftWarning?: { commentId: string; sequence: number };
}

type Action =
  | { type: 'host'; message: HostMessage }
  | { type: 'notice'; text: string; error?: boolean }
  | { type: 'clearNotice' }
  | { type: 'clearReveal' }
  | { type: 'clearDraftWarning' }
  | { type: 'requireDraft'; text: string }
  | { type: 'beginDraft'; draft: Draft }
  | { type: 'startSaving' }
  | { type: 'repository'; root: string }
  | { type: 'scope'; scope: ReviewState['scope'] }
  | { type: 'draftBody'; body: string }
  | { type: 'cancelDraft' }
  | { type: 'deleteDraft'; id: string }
  | { type: 'selectFile'; path: string }
  | { type: 'activeFile'; path: string }
  | { type: 'filesOpen'; open: boolean }
  | { type: 'toggleComments' }
  | { type: 'showComment'; id: string }
  | { type: 'query'; query: string }
  | { type: 'regex' }
  | { type: 'matchCase' }
  | { type: 'toggleWordWrap' }
  | { type: 'toggleTheme' };

const initialState: UIState = {
  review: { repositories: [], repository: initialLocalState.draft?.repository ?? initialLocalState.repository ?? '', branch: '', scope: initialLocalState.draft?.scope ?? initialLocalState.scope ?? 'uncommitted', files: [], comments: [] },
  busy: true,
  saving: false,
  draft: initialLocalState.draft,
  activePath: '',
  filesOpen: false,
  commentsOpen: true,
  pulseSequence: 0,
  query: initialLocalState.query ?? '',
  regex: initialLocalState.regex ?? false,
  matchCase: initialLocalState.matchCase ?? false,
  wordWrap: initialLocalState.wordWrap ?? true,
  theme: initialLocalState.theme ?? (document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light') ? 'light' : 'dark'),
};

function requireDraft(state: UIState, text: string): UIState {
  const sequence = state.pulseSequence + 1;
  return { ...state, commentsOpen: true, notice: { text }, reveal: undefined, pulseSequence: sequence, draftWarning: state.draft ? { commentId: state.draft.id ?? 'draft', sequence } : undefined };
}

function reducer(state: UIState, action: Action): UIState {
  switch (action.type) {
    case 'host': {
      const message = action.message;
      switch (message.type) {
        case 'state':
          if (state.loadingReview && (message.state.repository !== state.loadingReview.repository || message.state.scope !== state.loadingReview.scope)) return state;
          return { ...state, review: message.state, loadingReview: undefined, activePath: message.state.files.some(file => file.path === state.activePath) ? state.activePath : message.state.files[0]?.path ?? '' };
        case 'busy': return { ...state, busy: message.busy };
        case 'notice': return { ...state, notice: message };
        case 'saved': return { ...state, saving: false, draft: undefined, draftWarning: undefined };
        case 'saveFailed': return { ...state, saving: false };
        case 'reveal': {
          if (state.loadingReview) return state;
          const comment = message.comment;
          const file = state.review.files.find(file => file.path === comment.path);
          const row = findAnchor(file, comment.side, comment.line);
          const valid = row?.text === comment.code;
          return {
            ...state,
            commentsOpen: true,
            pulseSequence: state.pulseSequence + 1,
            reveal: { commentId: comment.id, rowId: valid && row ? rowId(comment.path, row) : undefined, sequence: state.pulseSequence + 1 },
            draftWarning: undefined,
            notice: valid ? state.notice : { text: 'This source line has changed or is no longer in the diff. Your comment retains its original location.', error: true },
          };
        }
      }
      break;
    }
    case 'notice': return { ...state, notice: action };
    case 'clearNotice': return { ...state, notice: undefined };
    case 'clearReveal': return { ...state, reveal: undefined };
    case 'clearDraftWarning': return { ...state, draftWarning: undefined };
    case 'requireDraft': return requireDraft(state, action.text);
    case 'repository':
    case 'scope': {
      if (state.draft || state.saving || state.loadingReview) return state;
      const repository = action.type === 'repository' ? action.root : state.review.repository;
      const scope = action.type === 'scope' ? action.scope : state.review.scope;
      return { ...state, busy: true, loadingReview: { repository, scope }, review: { ...state.review, repository, scope, branch: '', files: [], comments: [], error: undefined }, activePath: '', reveal: undefined, draftWarning: undefined, notice: undefined };
    }
    case 'startSaving': return state.draft ? { ...state, saving: true } : state;
    case 'beginDraft': return state.saving || state.loadingReview ? state : state.draft ? requireDraft(state, 'Save or cancel your current draft first.') : { ...state, draft: action.draft };
    case 'draftBody': return state.draft && !state.saving ? { ...state, draft: { ...state.draft, body: action.body } } : state;
    case 'cancelDraft': return state.saving ? state : { ...state, draft: undefined, draftWarning: undefined };
    case 'deleteDraft': return !state.saving && state.draft?.id === action.id ? { ...state, draft: undefined, draftWarning: undefined } : state;
    case 'selectFile': return { ...state, activePath: action.path, filesOpen: false };
    case 'activeFile': return state.activePath === action.path ? state : { ...state, activePath: action.path };
    case 'filesOpen': return { ...state, filesOpen: action.open };
    case 'toggleComments': return { ...state, commentsOpen: !state.commentsOpen };
    case 'showComment': return { ...state, commentsOpen: true, pulseSequence: state.pulseSequence + 1, reveal: { commentId: action.id, sequence: state.pulseSequence + 1 }, draftWarning: undefined };
    case 'query': return { ...state, query: action.query };
    case 'regex': return { ...state, regex: !state.regex };
    case 'matchCase': return { ...state, matchCase: !state.matchCase };
    case 'toggleWordWrap': return { ...state, wordWrap: !state.wordWrap };
    case 'toggleTheme': return { ...state, theme: state.theme === 'dark' ? 'light' : 'dark' };
  }
  return state;
}

export function useReview() {
  const [state, dispatch] = useReducer(reducer, initialState);
  useEffect(() => {
    const onMessage = (event: MessageEvent<HostMessage>) => { dispatch({ type: 'host', message: event.data }); };
    window.addEventListener('message', onMessage);
    post({ type: 'ready', scope: initialState.review.scope, repository: initialState.review.repository });
    return () => { window.removeEventListener('message', onMessage); };
  }, []);

  const { draft, query, regex, matchCase, wordWrap, theme, review: { scope, repository }, notice, reveal, draftWarning } = state;
  useEffect(() => { persist({ draft, query, regex, matchCase, wordWrap, theme, scope, repository }); }, [draft, query, regex, matchCase, wordWrap, theme, scope, repository]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => { dispatch({ type: 'clearNotice' }); }, notice.error ? 9000 : 3500);
    return () => { clearTimeout(timer); };
  }, [notice]);
  useEffect(() => {
    if (!reveal) return;
    const timer = setTimeout(() => { dispatch({ type: 'clearReveal' }); }, 1600);
    return () => { clearTimeout(timer); };
  }, [reveal]);
  useEffect(() => {
    if (!draftWarning) return;
    const timer = setTimeout(() => { dispatch({ type: 'clearDraftWarning' }); }, 1600);
    return () => { clearTimeout(timer); };
  }, [draftWarning]);
  return { state, dispatch };
}
