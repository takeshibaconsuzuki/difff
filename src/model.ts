import type { z } from 'zod';
import type { commentSchema, messageSchema, scopeSchema } from './validation';

export type Scope = z.infer<typeof scopeSchema>;
export type Side = 'old' | 'new';

export interface DiffLine {
  kind: 'context' | 'add' | 'delete' | 'note';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface ContextGap {
  id: string;
  before: number;
  oldStart: number;
  newStart: number;
  count: number;
}

export interface ReviewFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  hunks: Hunk[];
  snapshot: string;
  gaps: ContextGap[];
  notice?: string;
}

export type ReviewComment = z.infer<typeof commentSchema>;

export interface Repository {
  root: string;
  name: string;
}

export interface ReviewState {
  repositories: Repository[];
  repository: string;
  branch: string;
  scope: Scope;
  files: ReviewFile[];
  comments: ReviewComment[];
  error?: string;
}

export type ClientMessage = z.infer<typeof messageSchema>;

export type HostMessage =
  | { type: 'state'; state: ReviewState }
  | { type: 'busy'; busy: boolean }
  | { type: 'notice'; text: string; error?: boolean }
  | { type: 'reveal'; comment: ReviewComment }
  | { type: 'saveFailed' }
  | { type: 'saved' };

export function sourceLabel(comment: Pick<ReviewComment, 'scope' | 'side'>): string {
  if (comment.side === 'old') return comment.scope === 'unstaged' ? 'index' : 'HEAD';
  return comment.scope === 'staged' ? 'index' : 'working tree';
}

export function formatComments(comments: ReviewComment[]): string {
  return comments.map(comment => `${comment.path}:${comment.line}\n${comment.body}`).join('\n\n');
}

export function findAnchor(file: ReviewFile | undefined, side: Side, line: number): DiffLine | undefined {
  return file?.hunks.flatMap(hunk => hunk.lines).find(row => (side === 'old' ? row.oldLine : row.newLine) === line);
}
