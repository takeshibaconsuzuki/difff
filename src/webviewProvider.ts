import * as vscode from "vscode";
import { DiffComment } from "./commentService";
import { getWebviewScript } from "./webviewScript";
import { webviewStyles } from "./webviewStyles";

export interface FileDiff {
  path: string;
  content: string;
  additions: number;
  deletions: number;
}

interface DiffLine {
  type: "addition" | "deletion" | "context";
  content: string;
  oldLineNum: number | "";
  newLineNum: number | "";
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

type ViewMode = "branch" | "working" | "single";

const iconPaths = {
  diff: '<path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M7 8h4M9 6v4M13 16h4"/>',
  branch:
    '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10M18 7a8 8 0 0 1-8 8H6"/>',
  arrow: '<path d="M4 12h16m-5-5 5 5-5 5"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5M6.1 6a8 8 0 0 1 13.4 3M4.5 15A8 8 0 0 0 18 18"/>',
  comment:
    '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0zM7 9h9M7 13h6"/>',
  open: '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16"/>',
};

export class DiffWebviewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  getWebviewContent(diffContent: string, fileName: string): string {
    const lines = this.parseDiff(diffContent.split("\n")).flatMap(
      (hunk) => hunk.lines,
    );
    return this.generateDiffHTML(
      [
        {
          path: fileName,
          content: diffContent,
          additions: lines.filter((line) => line.type === "addition").length,
          deletions: lines.filter((line) => line.type === "deletion").length,
        },
      ],
      "single",
    );
  }

  getAllDiffsContent(
    fileDiffs: FileDiff[],
    baseRef?: string,
    compareRef?: string,
    comments: Map<string, DiffComment[]> = new Map(),
    currentUser?: string,
  ): string {
    return this.generateDiffHTML(
      fileDiffs,
      "branch",
      baseRef,
      compareRef,
      comments,
      currentUser,
    );
  }

  getWorkingDirectoryContent(
    fileDiffs: FileDiff[],
    comments: Map<string, DiffComment[]> = new Map(),
    currentUser?: string,
  ): string {
    return this.generateDiffHTML(
      fileDiffs,
      "working",
      "HEAD",
      "working",
      comments,
      currentUser,
    );
  }

  private icon(name: keyof typeof iconPaths, className = ""): string {
    return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name]}</svg>`;
  }

  private fileId(path: string): string {
    // Keep paths like a-b.ts and a_b.ts distinct, including non-ASCII names.
    return `file-${Buffer.from(path, "utf8").toString("hex")}`;
  }

  private changeBar(additions: number, deletions: number): string {
    const total = additions + deletions;
    return `<span class="change-bar" aria-hidden="true"><span class="added-bar" style="width:${total ? (additions / total) * 100 : 0}%"></span><span class="removed-bar" style="width:${total ? (deletions / total) * 100 : 0}%"></span></span>`;
  }

  private fileStatus(content: string): { label: string; code: string } {
    if (/^new file mode /m.test(content)) {
      return { label: "Added", code: "A" };
    }
    if (/^deleted file mode /m.test(content)) {
      return { label: "Deleted", code: "D" };
    }
    if (/^rename from /m.test(content)) {
      return { label: "Renamed", code: "R" };
    }
    return { label: "Modified", code: "M" };
  }

  private generateDiffHTML(
    fileDiffs: FileDiff[],
    mode: ViewMode,
    baseRef?: string,
    compareRef?: string,
    comments: Map<string, DiffComment[]> = new Map(),
    currentUser = "User",
  ): string {
    const additions = fileDiffs.reduce((sum, file) => sum + file.additions, 0);
    const deletions = fileDiffs.reduce((sum, file) => sum + file.deletions, 0);
    const commentCount = fileDiffs.reduce(
      (sum, file) => sum + (comments.get(file.path)?.length || 0),
      0,
    );
    const title =
      mode === "working"
        ? "Working changes"
        : mode === "single"
          ? "File changes"
          : "Compare changes";
    const viewKey = JSON.stringify([
      mode,
      baseRef,
      compareRef,
      mode === "single" ? fileDiffs[0]?.path : "",
    ]);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.escapeHtml(title)} · Difff</title>
    <style>${webviewStyles}</style>
</head>
<body>
    <header class="page-header">
        <div class="header-top">
            <div class="heading">
                <div class="brand-mark">${this.icon("diff")}</div>
                <div><div class="eyebrow">DIFFF / CODE REVIEW</div><h1>${title}</h1></div>
            </div>
            ${
              mode !== "single"
                ? `<div class="header-actions">
                <button class="button subtle" id="copy-comments-btn" title="Copy all comments" aria-label="Copy all comments" ${commentCount === 0 ? "disabled" : ""}>
                    ${this.icon("comment")}<span class="button-label">Copy comments <span class="comment-count">${commentCount}</span></span>
                </button>
                <button class="button" id="reload-diff-btn" title="Refresh changes" aria-label="Refresh changes">
                    ${this.icon("refresh")}<span class="button-label">Refresh</span>
                </button>
            </div>`
                : ""
            }
        </div>
        <div class="comparison" aria-label="Comparison">
            ${
              mode === "single"
                ? `<span class="ref">${this.icon("file")}<span>${this.escapeHtml(fileDiffs[0]?.path || "")}</span></span>`
                : `
            <span class="ref" title="Base reference">${this.icon("branch")}<span>${this.escapeHtml(baseRef || "Base")}</span></span>
            ${this.icon("arrow")}
            <span class="ref" title="Compare reference">${this.icon(mode === "working" ? "code" : "branch")}<span>${this.escapeHtml(mode === "working" ? "Working directory" : compareRef || "Compare")}</span></span>
            <span class="comparison-note">${mode === "working" ? "Your changes since the last commit" : "Review what changed between references"}</span>`
            }
        </div>
        <div class="summary">
            <div class="summary-counts">
                <span><strong>${fileDiffs.length}</strong> <span class="muted">${fileDiffs.length === 1 ? "file" : "files"} changed</span></span>
                <span class="additions"><strong>+${additions}</strong> additions</span>
                <span class="deletions"><strong>−${deletions}</strong> deletions</span>
                ${this.changeBar(additions, deletions)}
            </div>
            <span class="summary-note">${this.icon("code")} Unified diff</span>
        </div>
    </header>
    <div class="review-layout">
        <aside class="file-sidebar" aria-label="Changed files">
            <div class="sidebar-heading"><h2>Files changed</h2><span class="count-badge">${fileDiffs.length}</span></div>
            <label class="search-box">${this.icon("search")}<span class="sr-only">Filter files</span><input type="search" id="file-search" placeholder="Filter files…" autocomplete="off" spellcheck="false"></label>
            <nav class="file-list" aria-label="File navigation">
                ${fileDiffs.map((file) => this.renderFileLink(file)).join("")}
            </nav>
            <div class="sidebar-footer">${mode === "single" ? "Select a file to jump to its changes." : "Select a line’s + to leave a comment."}</div>
        </aside>
        <main class="content" id="changes">
            <div class="content-toolbar">
                <h2 id="visible-files">Changed files</h2>
                <div class="toolbar-actions"><span class="view-label">Lines wrap automatically</span><button class="button subtle" id="collapse-all">Collapse all</button></div>
            </div>
            <div class="empty-diff" id="no-matches" hidden>
                <div class="empty-icon">${this.icon("search")}</div><h2>No matching files</h2><p>Try a different filename or path.</p><button class="button" id="clear-filter">Clear filter</button>
            </div>
            ${fileDiffs.length === 0 ? `<div class="empty-diff"><div class="empty-icon">${this.icon("check")}</div><h2>${mode === "working" ? "Your working directory is clean" : "No changes to review"}</h2><p>${mode === "working" ? "Changes you make will appear here." : "These references have the same file contents."}</p></div>` : fileDiffs.map((file) => this.renderFileDiff(file, comments.get(file.path) || [], mode !== "single")).join("")}
        </main>
    </div>
    <div id="review-status" class="sr-only" role="status" aria-live="polite"></div>
    <script>${getWebviewScript(currentUser, viewKey)}</script>
</body>
</html>`;
  }

  private renderFileLink(file: FileDiff): string {
    const slash = file.path.lastIndexOf("/");
    const directory = file.path.slice(0, slash + 1);
    const name = file.path.slice(slash + 1);
    const status = this.fileStatus(file.content);
    return `<a class="file-link" href="#${this.fileId(file.path)}" data-file-path="${this.escapeHtml(file.path)}" title="${this.escapeHtml(file.path)} (+${file.additions} −${file.deletions})">
        ${this.icon("file")}<span class="nav-file-label"><span class="nav-filename">${this.escapeHtml(name)}</span>${directory ? `<span class="nav-directory">${this.escapeHtml(directory)}</span>` : ""}</span>
        <span class="file-status status-${status.label.toLowerCase()}" aria-label="${status.label}" title="${status.label}">${status.code}</span>
    </a>`;
  }

  private renderFileDiff(
    file: FileDiff,
    comments: DiffComment[],
    interactive: boolean,
  ): string {
    const hunks = this.parseDiff(file.content.split("\n"));
    const fileId = this.fileId(file.path);
    const path = this.escapeHtml(file.path);
    const slash = file.path.lastIndexOf("/");
    return `<section class="file-diff" id="${fileId}" data-file-path="${path}" aria-label="${path}">
        <div class="file-header">
            <button class="icon-button file-toggle" aria-expanded="true" aria-controls="${fileId}-body" aria-label="Collapse ${path}">${this.icon("chevron")}</button>
            ${this.icon("file", "file-type-icon muted")}
            <h3><button class="file-header-title" data-open-file="${path}" title="Open ${path} in editor"><span class="file-directory">${this.escapeHtml(file.path.slice(0, slash + 1))}</span><span class="file-name">${this.escapeHtml(file.path.slice(slash + 1))}</span></button></h3>
            <div class="file-stats"><span class="additions" aria-label="${file.additions} additions">+${file.additions}</span><span class="deletions" aria-label="${file.deletions} deletions">−${file.deletions}</span>${this.changeBar(file.additions, file.deletions)}</div>
            <button class="icon-button" data-open-file="${path}" title="Open in editor" aria-label="Open ${path} in editor">${this.icon("open")}</button>
        </div>
        <div class="file-body" id="${fileId}-body">
            ${hunks.length ? `<table class="diff-table" aria-label="Changes in ${path}"><colgroup><col class="diff-gutter"><col class="diff-gutter"><col></colgroup><tbody>${this.renderHunks(hunks, file.path, comments, interactive)}</tbody></table>` : `<div class="no-changes">${this.getEmptyDiffMessage(file.content)}</div>`}
        </div>
    </section>`;
  }

  private renderHunks(
    hunks: DiffHunk[],
    filePath: string,
    comments: DiffComment[],
    interactive: boolean,
  ): string {
    return hunks
      .map((hunk) => {
        const header = `<tr><td colspan="3" class="diff-hunk-header">${this.escapeHtml(hunk.header)}</td></tr>`;
        return (
          header +
          hunk.lines
            .map((line) => {
              const lineNumber = line.newLineNum || line.oldLineNum;
              const commentButton =
                interactive && lineNumber
                  ? `<button class="add-comment-button" data-file-path="${this.escapeHtml(filePath)}" data-line-number="${lineNumber}" data-line-type="${line.type}" title="Add a comment" aria-label="Comment on ${this.escapeHtml(filePath)} line ${lineNumber} (${line.type})">+</button>`
                  : "";
              let html = `<tr class="diff-line diff-line-${line.type}" data-line-num="${lineNumber}" data-line-type="${line.type}">
            <td class="diff-line-num"><div class="diff-line-wrapper">${commentButton}${line.oldLineNum}</div></td>
            <td class="diff-line-num">${line.newLineNum}</td>
            <td class="diff-line-content">${this.escapeHtml(line.content)}</td>
        </tr>`;
              const lineComments = comments.filter(
                (comment) =>
                  comment.lineNumber === lineNumber &&
                  comment.lineType === line.type,
              );
              if (lineComments.length) {
                const threadId = `${this.fileId(filePath)}-${lineNumber}-${line.type}`;
                html += `<tr class="comment-thread-row"><td colspan="3">
            <div class="comment-thread-container" data-thread-id="${threadId}">
                <button class="comment-thread-header" data-toggle-thread="${threadId}" aria-expanded="true" aria-controls="${threadId}-comments"><span class="comment-thread-toggle" aria-hidden="true">▼</span><span class="thread-count">${lineComments.length} comment${lineComments.length === 1 ? "" : "s"}</span></button>
                <div class="comment-thread-body" id="${threadId}-comments">${lineComments.map((comment) => this.renderComment(comment)).join("")}</div>
            </div>
          </td></tr>`;
              }
              return html;
            })
            .join("")
        );
      })
      .join("");
  }

  private renderComment(comment: DiffComment): string {
    const timestamp = new Date(comment.timestamp).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const initials = comment.author
      .split(" ")
      .map((name) => name.charAt(0).toUpperCase())
      .join("")
      .slice(0, 2);
    const id = this.escapeHtml(comment.id);
    return `<div class="comment-item" data-comment-id="${id}">
        <div class="comment-avatar" aria-hidden="true">${this.escapeHtml(initials)}</div>
        <div class="comment-body">
            <div class="comment-header"><span class="comment-author">${this.escapeHtml(comment.author)}</span><span class="comment-timestamp">${timestamp}</span></div>
            <div class="comment-content">${this.escapeHtml(comment.content)}</div>
            <div class="comment-actions-menu">
                <button class="comment-action-btn" data-copy-comment="${this.escapeHtml(JSON.stringify(comment))}">Copy</button>
                <button class="comment-action-btn" data-edit-comment="${id}">Edit</button>
                <button class="comment-action-btn" data-delete-comment="${id}">Delete</button>
            </div>
        </div>
    </div>`;
  }

  private getEmptyDiffMessage(content: string): string {
    if (
      /^Binary files .* differ$/m.test(content) ||
      /^GIT binary patch$/m.test(content)
    ) {
      return "Binary file contents are not displayed";
    }
    if (/^new file mode /m.test(content)) {
      return "New empty file";
    }
    if (/^rename from /m.test(content)) {
      return "File renamed without content changes";
    }
    if (/^old mode /m.test(content)) {
      return "File permissions changed; contents are unchanged";
    }
    return "No changes in this file";
  }

  private parseDiff(lines: string[]): DiffHunk[] {
    const hunks: DiffHunk[] = [];
    let currentHunk: DiffHunk | null = null;
    let oldLineNum = 0;
    let newLineNum = 0;
    for (const line of lines) {
      if (line.startsWith("diff --git ")) {
        if (currentHunk) {
          hunks.push(currentHunk);
          currentHunk = null;
        }
      } else if (line.startsWith("@@")) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }
        const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
        if (match) {
          oldLineNum = parseInt(match[1]);
          newLineNum = parseInt(match[2]);
        }
        currentHunk = { header: line, lines: [] };
      } else if (currentHunk) {
        if (line.startsWith("+")) {
          currentHunk.lines.push({
            type: "addition",
            content: line.substring(1),
            newLineNum: newLineNum++,
            oldLineNum: "",
          });
        } else if (line.startsWith("-")) {
          currentHunk.lines.push({
            type: "deletion",
            content: line.substring(1),
            oldLineNum: oldLineNum++,
            newLineNum: "",
          });
        } else if (line.startsWith(" ")) {
          currentHunk.lines.push({
            type: "context",
            content: line.substring(1),
            oldLineNum: oldLineNum++,
            newLineNum: newLineNum++,
          });
        }
      }
    }
    if (currentHunk) {
      hunks.push(currentHunk);
    }
    return hunks;
  }

  private escapeHtml(text: string): string {
    const entities = new Map([
      ["&", "&amp;"],
      ["<", "&lt;"],
      [">", "&gt;"],
      ['"', "&quot;"],
      ["'", "&#39;"],
    ]);
    return text.replace(/[&<>"']/g, (character) => entities.get(character)!);
  }
}
