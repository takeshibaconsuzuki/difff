import { memo, useState, type RefObject } from 'react';
import { Moon, Search, Sun } from 'lucide-react';
import type { ReviewState, Scope } from '../model';
import { Button, FileStatus } from './ui';

const scopes = ['uncommitted', 'staged', 'unstaged'] as const;
const scopeDescriptions: Record<Scope, string> = {
  uncommitted: 'HEAD → working tree\nAll local changes, including untracked files.',
  staged: 'HEAD → index\nChanges ready for your next commit.',
  unstaged: 'Index → working tree\nChanges that haven’t been staged, including untracked files.',
};

export function Toolbar({ review, busy, query, regex, matchCase, commentsOpen, filesOpen, searchCount, hasMatches, queryRef, theme, focused,
  onScope, onRepository, onQuery, onRegex, onMatchCase, onMatch, onRefresh, onCopy, onComments, onFiles, onEscape, onTheme }: {
  review: ReviewState;
  busy: boolean;
  query: string;
  regex: boolean;
  matchCase: boolean;
  commentsOpen: boolean;
  filesOpen: boolean;
  searchCount: string;
  hasMatches: boolean;
  queryRef: RefObject<HTMLInputElement | null>;
  theme: 'light' | 'dark';
  focused: boolean;
  onTheme: () => void;
  onScope: (scope: Scope) => void;
  onRepository: (root: string) => void;
  onQuery: (query: string) => void;
  onRegex: () => void;
  onMatchCase: () => void;
  onMatch: (direction: number) => void;
  onRefresh: () => void;
  onCopy: () => void;
  onComments: () => void;
  onFiles: () => void;
  onEscape: () => void;
}) {
  return <div className="toolbar">
    <Button id="toggle-files" aria-expanded={filesOpen} onClick={onFiles}>Files</Button>
    <select id="repository" aria-label="Repository" title="Select repository" hidden={review.repositories.length < 2} disabled={busy} value={review.repository} onChange={event => onRepository(event.target.value)}>
      {review.repositories.map(repo => <option key={repo.root} value={repo.root} title={repo.root}>{repo.name}</option>)}
    </select>
    <div id="scopes" className="segments" aria-label="Change scope">
      {scopes.map(scope => <Button key={scope} data-scope={scope} title={scopeDescriptions[scope]} className={scope === review.scope ? 'selected' : ''} aria-pressed={scope === review.scope} disabled={busy} onClick={() => onScope(scope)}>{scope.charAt(0).toUpperCase() + scope.slice(1)}</Button>)}
    </div>
    <div className="search" role="search">
      <Search className="search-icon" size={16} aria-hidden="true" />
      <input id="query" ref={queryRef} placeholder="Find…" aria-label="Find in diff" title="Search currently loaded diff lines. Expand context to include more." autoComplete="off" spellCheck={false} value={query}
        onChange={event => onQuery(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); onMatch(event.shiftKey ? -1 : 1); }
          if (event.key === 'Escape') { event.preventDefault(); onQuery(''); onEscape(); }
        }} />
      <Button id="match-case" className="search-option" title="Match case" aria-pressed={matchCase} onClick={onMatchCase}>Aa</Button>
      <Button id="regex" className="search-option" title="Use regular expression" aria-pressed={regex} onClick={onRegex}>.*</Button>
      <span id="search-count" aria-live="polite">{searchCount}</span>
      <Button id="previous" title="Previous match (Shift+Enter)" aria-label="Previous match" disabled={!hasMatches} onClick={() => onMatch(-1)}>↑</Button>
      <Button id="next" title="Next match (Enter)" aria-label="Next match" disabled={!hasMatches} onClick={() => onMatch(1)}>↓</Button>
    </div>
    <Button id="refresh" title="Refresh changes" disabled={busy} onClick={onRefresh}>↻</Button>
    <Button id="copy" className="primary" disabled={busy || !review.comments.length} onClick={onCopy}>Copy comments</Button>
    <Button id="toggle-comments" className="comments-toggle" aria-expanded={commentsOpen} onClick={onComments}>Comments <span id="comment-count" className="count">{review.comments.length}</span></Button>
    <Button id="toggle-theme" className="icon-button" title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-pressed={theme === 'dark'} onClick={onTheme}>
      {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
    </Button>
    <span id="focus-status" className={`focus-status${focused ? ' focused' : ''}`} role="status" aria-label={focused ? 'Review focused: keyboard shortcuts active' : 'Review not focused: click the review to use keyboard shortcuts'} title={focused ? 'Review focused — keyboard shortcuts active' : 'Review not focused — click here to use keyboard shortcuts'} />
  </div>;
}

export const FilesPane = memo(function FilesPane({ review, activePath, jump, filterRef }: {
  review: ReviewState;
  activePath: string;
  jump: (path: string) => void;
  filterRef: RefObject<HTMLInputElement | null>;
}) {
  const [filter, setFilter] = useState('');
  const files = review.files.filter(file => file.path.toLowerCase().includes(filter.toLowerCase()));
  return <aside className="files-pane" aria-label="Changed files">
    <div className="pane-heading">FILES <span id="file-count" className="count">{review.files.length}</span></div>
    <input id="file-filter" ref={filterRef} className="file-filter" placeholder="Jump to file…" aria-label="Filter files" value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => {
      if (event.key === 'Enter' && files[0]) jump(files[0].path);
    }} />
    <nav id="files">
      {files.map(file => {
        const slash = file.path.lastIndexOf('/');
        const count = review.comments.filter(comment => comment.path === file.path && comment.scope === review.scope).length;
        return <Button key={file.path} title={file.path} data-path={file.path} className={`file-link${file.path === activePath ? ' active' : ''}`} aria-current={file.path === activePath} onClick={() => jump(file.path)}>
          <FileStatus status={file.status} />
          <span className="file-name"><span className="basename">{file.path.slice(slash + 1)}</span>{slash >= 0 && <span className="directory">{file.path.slice(0, slash)}</span>}</span>
          {!!count && <span className="comment-dot">{count}</span>}
        </Button>;
      })}
      {!files.length && !!review.files.length && <p className="small-empty">No matching files.</p>}
    </nav>
  </aside>;
});
