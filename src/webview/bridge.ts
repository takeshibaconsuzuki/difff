import type { ClientMessage, DiffLine, Scope, Side } from '../model';

export interface Draft {
  repository: string;
  path: string;
  side: Side;
  line: number;
  code: string;
  scope: Scope;
  body: string;
  id?: string;
}

export interface LocalState {
  draft?: Draft;
  scope?: Scope;
  repository?: string;
  query?: string;
  regex?: boolean;
  matchCase?: boolean;
  theme?: 'light' | 'dark';
}

declare function acquireVsCodeApi(): {
  postMessage(message: ClientMessage): void;
  getState(): LocalState | undefined;
  setState(state: LocalState): void;
};

// Acquire the VS Code bridge once, outside React's mount/unmount lifecycle.
const vscode = acquireVsCodeApi();
export const initialLocalState = vscode.getState() ?? {};
export const post = (message: ClientMessage): void => { vscode.postMessage(message); };
export const persist = (state: LocalState): void => { vscode.setState(state); };
export const rowId = (path: string, row: DiffLine): string => JSON.stringify([path, row.oldLine, row.newLine]);
