import type { z } from 'zod';
import type { commentSchema, messageSchema } from './validation';

export type Side = 'old' | 'new';
export const WORKING = 'WORKING';
export const INDEX = 'INDEX';

export interface DiffLine {
  kind: 'context' | 'add' | 'delete' | 'note';
  text: string;
  // Ignored whitespace can give a context row different text on each side.
  oldText?: string;
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
  originalPath?: string;
  canOpen: boolean;
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
  baseRef: string;
  endRef: string;
  files: ReviewFile[];
  ignoreWhitespace: boolean;
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
  | { type: 'saved' }
  | { type: 'layout'; canMaximize: boolean };

export interface Comparison {
  baseRef: string;
  endRef: string;
}

export function sameComparison(a: Comparison, b: Comparison): boolean {
  return a.baseRef === b.baseRef && a.endRef === b.endRef;
}

export function sourceLabel(comment: Pick<ReviewComment, 'side' | 'baseRef' | 'endRef'>): string {
  const local = (ref: string) => ref === INDEX || ref === WORKING;
  const [ref, other] = comment.side === 'new' ? [comment.endRef, comment.baseRef] : [comment.baseRef, comment.endRef];
  if (local(ref)) return ref;
  // Local endpoints build on HEAD, so a ref compared against them is diffed from its merge base with HEAD.
  if (local(other)) return ref === 'HEAD' ? ref : `merge base of ${ref} and HEAD`;
  return comment.side === 'new' ? ref : `merge base of ${comment.baseRef} and ${comment.endRef}`;
}

export function formatComments(comments: ReviewComment[]): string {
  return comments.map(comment => `${comment.path}:${comment.line}\n${comment.body}`).join('\n\n');
}

export function findAnchor(file: ReviewFile | undefined, side: Side, line: number): DiffLine | undefined {
  const row = file?.hunks.flatMap(hunk => hunk.lines).find(row => (side === 'old' ? row.oldLine : row.newLine) === line);
  return row && side === 'old' && row.oldText !== undefined ? { ...row, text: row.oldText } : row;
}
