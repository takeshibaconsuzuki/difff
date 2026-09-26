import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { GitReview } from './git';
import { findAnchor, formatComments, type ClientMessage, type HostMessage, type Repository, type ReviewComment, type ReviewState } from './model';
import { commentSchema, messageSchema } from './validation';

const STORAGE_KEY = 'difff.comments.v1';

export function reviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const resource = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', file)).toString();
  const nonce = randomUUID();
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; worker-src blob:; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${resource('review.css')}"><title>difff · Review changes</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${resource('review.js')}"></script></body></html>`;
}

class ReviewPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private comments: ReviewComment[];
  private state: ReviewState = { repositories: [], repository: '', branch: '', scope: 'uncommitted', files: [], comments: [] };
  private gitReview?: GitReview;
  private queue = Promise.resolve();
  private closed = false;

  constructor(private readonly context: vscode.ExtensionContext, onClose: () => void) {
    this.comments = commentSchema.array().safeParse(context.workspaceState.get<unknown>(STORAGE_KEY, [])).data ?? [];
    this.panel = vscode.window.createWebviewPanel('difff.review', 'difff · Review', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    });
    this.panel.iconPath = new vscode.ThemeIcon('diff');
    this.panel.webview.html = reviewHtml(this.panel.webview, context.extensionUri);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((raw: unknown) => {
        const parsed = messageSchema.safeParse(raw);
        if (!parsed.success) return;
        this.queue = this.queue.then(async () => {
          if (this.closed) return;
          this.send({ type: 'busy', busy: true });
          try { await this.handle(parsed.data); }
          catch (error) {
            this.send({ type: 'notice', text: error instanceof Error ? error.message : String(error), error: true });
            if (parsed.data.type === 'comment' || parsed.data.type === 'edit') this.send({ type: 'saveFailed' });
          }
          finally { this.send({ type: 'busy', busy: false }); }
        });
      }),
      this.panel.onDidDispose(() => {
        this.closed = true;
        this.disposables.forEach(disposable => { disposable.dispose(); });
        onClose();
      }),
    );
  }

  dispose(): void { this.panel.dispose(); }
  reveal(): void { this.panel.reveal(); }
  private send(message: HostMessage): void { if (!this.closed) void this.panel.webview.postMessage(message); }
  private publish(): void {
    this.state.comments = this.comments.filter(comment => comment.repository === this.state.repository);
    this.send({ type: 'state', state: this.state });
  }

  private async repositories(): Promise<Repository[]> {
    const roots = new Set<string>();
    // The built-in Git extension also knows about nested repositories and submodules.
    const gitExtension = vscode.extensions.getExtension<{ getAPI(version: number): { repositories: { rootUri: vscode.Uri }[] } }>('vscode.git');
    if (gitExtension) {
      try {
        const api = (await gitExtension.activate()).getAPI(1);
        for (const repository of api.repositories) if (repository.rootUri.scheme === 'file') roots.add(repository.rootUri.fsPath);
      } catch { /* Workspace probing below works when the Git extension is disabled. */ }
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') continue;
      try { roots.add((await simpleGit(folder.uri.fsPath).revparse(['--show-toplevel'])).trim()); }
      catch { /* Non-Git workspace folders do not need a review entry. */ }
    }
    const repositories = new Map<string, Repository>();
    for (const value of roots) {
      const root = path.resolve(value);
      const key = process.platform === 'win32' ? root.toLowerCase() : root;
      if (!repositories.has(key)) repositories.set(key, { root, name: path.basename(root) });
    }
    return [...repositories.values()];
  }

  private async refresh(discover = false): Promise<void> {
    if (discover || !this.state.repositories.length) this.state.repositories = await this.repositories();
    if (!this.state.repositories.some(repo => repo.root === this.state.repository)) {
      this.state.repository = this.state.repositories[0]?.root ?? '';
    }
    this.state.error = undefined;
    if (!this.state.repository) {
      this.state.files = [];
      this.state.error = 'Open a folder containing a Git repository, then refresh to start a review.';
    } else {
      try {
        const git = new GitReview(this.state.repository);
        this.gitReview = git;
        [this.state.files, this.state.branch] = await Promise.all([git.files(this.state.scope), git.branch()]);
      } catch (error) {
        this.state.files = [];
        this.state.error = `Unable to load changes. ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    this.publish();
  }

  private async save(comments: ReviewComment[]): Promise<void> {
    await this.context.workspaceState.update(STORAGE_KEY, comments);
    this.comments = comments;
    this.publish();
  }

  private async handle(message: ClientMessage): Promise<void> {
    const git = () => this.gitReview ?? new GitReview(this.state.repository);
    const comment = 'id' in message ? this.comments.find(item => item.id === message.id && item.repository === this.state.repository) : undefined;
    switch (message.type) {
      case 'ready':
        this.state.scope = message.scope ?? 'uncommitted';
        this.state.repository = message.repository ?? '';
        await this.refresh(true);
        break;
      case 'refresh': await this.refresh(true); break;
      case 'scope':
        this.state.scope = message.scope;
        await this.refresh();
        break;
      case 'repository':
        if (!this.state.repositories.some(repo => repo.root === message.root)) break;
        this.state.repository = message.root;
        await this.refresh();
        break;
      case 'expand':
      case 'expandAll': {
        const index = this.state.files.findIndex(file => file.path === message.path);
        const file = this.state.files[index];
        if (!file || file.snapshot !== message.snapshot) break;
        this.state.files[index] = message.type === 'expandAll' ? git().expandAll(file) : git().expand(file, message.gap, message.direction);
        this.publish();
        break;
      }
      case 'comment': {
        const line = findAnchor(this.state.files.find(file => file.path === message.path), message.side, message.line);
        if (message.repository !== this.state.repository || message.scope !== this.state.scope || !line || line.text !== message.code) throw new Error('This line or review scope has changed. Refresh the diff before commenting. Your draft is still available.');
        await this.save([...this.comments, {
          id: randomUUID(), repository: this.state.repository, scope: this.state.scope,
          path: message.path, side: message.side, line: message.line, code: line.text,
          body: message.body, createdAt: new Date().toISOString(),
        }]);
        this.send({ type: 'saved' });
        break;
      }
      case 'edit':
        if (!comment) throw new Error('This comment is no longer available. Your draft is still available.');
        await this.save(this.comments.map(item => item.id === comment.id ? { ...item, body: message.body } : item));
        this.send({ type: 'saved' });
        break;
      case 'delete':
        if (comment) await this.save(this.comments.filter(item => item.id !== comment.id));
        break;
      case 'clear':
        await this.save(this.comments.filter(item => item.repository !== this.state.repository));
        this.send({ type: 'notice', text: 'All comments in this repository cleared.' });
        break;
      case 'copy': {
        const comments = this.comments.filter(item => item.repository === this.state.repository);
        if (!comments.length) break;
        await vscode.env.clipboard.writeText(formatComments(comments));
        this.send({ type: 'notice', text: `${comments.length} ${comments.length === 1 ? 'comment' : 'comments'} copied with source locations.` });
        break;
      }
      case 'jump':
        if (comment) {
          if (comment.scope !== this.state.scope) {
            this.state.scope = comment.scope;
            await this.refresh();
          }
          const file = this.state.files.find(item => item.path === comment.path);
          if (file && !findAnchor(file, comment.side, comment.line)) {
            const expanded = git().reveal(file, comment.side, comment.line);
            this.state.files[this.state.files.indexOf(file)] = expanded;
            this.publish();
          }
          this.send({ type: 'reveal', comment });
        }
        break;
      case 'open': {
        const file = this.state.files.find(file => file.path === message.path);
        if (!file || file.status === 'D') break;
        const uri = vscode.Uri.file(git().resolve(file.path));
        const document = await vscode.workspace.openTextDocument(uri);
        const line = Math.min(message.line - 1, document.lineCount - 1);
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: true, selection: new vscode.Range(line, 0, line, 0) });
        break;
      }
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  let review: ReviewPanel | undefined;
  context.subscriptions.push(
    vscode.commands.registerCommand('difff.openReview', () => {
      if (review) review.reveal();
      else review = new ReviewPanel(context, () => { review = undefined; });
    }),
    { dispose: () => review?.dispose() },
  );
}
