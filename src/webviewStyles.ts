export const webviewStyles = `
    :root {
        color-scheme: light dark;
        --page: var(--vscode-editor-background, #ffffff);
        --surface: var(--vscode-sideBar-background, #f7f8fa);
        --text: var(--vscode-editor-foreground, #24292f);
        --muted: var(--vscode-descriptionForeground, #66717e);
        --border: var(--vscode-panel-border, #dfe3e8);
        --hover: var(--vscode-list-hoverBackground, #edf0f4);
        --accent: var(--vscode-textLink-foreground, #0969da);
        --focus: var(--vscode-focusBorder, #0969da);
        --added: var(--vscode-gitDecoration-addedResourceForeground, #1a7f37);
        --removed: var(--vscode-gitDecoration-deletedResourceForeground, #cf222e);
        --added-bg: var(--vscode-diffEditor-insertedLineBackground, #2da44e14);
        --removed-bg: var(--vscode-diffEditor-removedLineBackground, #f8514914);
        --mono: var(--vscode-editor-font-family, 'Cascadia Code', Consolas, monospace);
        --header-height: 158px;
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body {
        margin: 0;
        background: var(--page);
        color: var(--text);
        font: 13px/1.5 var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    }
    button, input, textarea { font: inherit; }
    button { color: inherit; cursor: pointer; }
    button:disabled { cursor: default; opacity: .55; }
    button, a, input, textarea { -webkit-tap-highlight-color: transparent; }
    :focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
    .icon { width: 16px; height: 16px; flex-shrink: 0; vertical-align: middle; }
    .page-header {
        position: sticky;
        top: 0;
        z-index: 20;
        background: var(--page);
        border-bottom: 1px solid var(--border);
        padding: 24px 28px 0;
    }
    .header-top, .heading, .header-actions, .comparison, .summary,
    .summary-counts, .file-stats, .content-toolbar, .toolbar-actions {
        display: flex;
        align-items: center;
        gap: 12px;
    }
    .header-top { justify-content: space-between; gap: 20px; }
    .heading { gap: 14px; min-width: 0; }
    .brand-mark {
        width: 38px;
        height: 38px;
        border: 1px solid var(--border);
        border-radius: 9px;
        display: grid;
        place-items: center;
        background: var(--surface);
        color: var(--accent);
    }
    .brand-mark .icon { width: 22px; height: 22px; }
    .eyebrow { color: var(--muted); font-size: 10px; font-weight: 650; letter-spacing: 1.4px; }
    h1 { margin: 1px 0 0; font-size: 23px; line-height: 1.3; letter-spacing: -.5px; font-weight: 600; }
    .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        min-height: 32px;
        padding: 5px 11px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--page);
        white-space: nowrap;
        font-size: 12px;
        font-weight: 500;
    }
    .button:hover:not(:disabled), .icon-button:hover, .comment-action-btn:hover { background: var(--hover); }
    .button.subtle { background: transparent; border-color: transparent; color: var(--muted); }
    .button.primary {
        background: var(--vscode-button-background, #0969da);
        color: var(--vscode-button-foreground, #fff);
        border-color: transparent;
    }
    .button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, #075ab9); }
    .button.loading .icon { animation: spin 1s linear infinite; }
    .comparison { margin: 20px 0 18px; gap: 9px; color: var(--muted); flex-wrap: wrap; }
    .ref {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
        max-width: 100%;
        padding: 4px 9px;
        border-radius: 5px;
        border: 1px solid var(--border);
        background: var(--surface);
        color: var(--text);
        font: 12px/1.6 var(--mono);
    }
    .ref span { overflow-wrap: anywhere; min-width: 0; }
    .comparison-note { font-size: 12px; margin-left: 4px; }
    .summary { min-height: 43px; justify-content: space-between; border-top: 1px solid var(--border); gap: 16px; }
    .summary-counts { gap: 18px; font-size: 12px; flex-wrap: wrap; padding: 10px 0; }
    .summary-counts strong { font-weight: 650; }
    .muted { color: var(--muted); }
    .additions { color: var(--added); }
    .deletions { color: var(--removed); }
    .change-bar { display: flex; width: 72px; height: 5px; overflow: hidden; border-radius: 2px; background: var(--border); gap: 2px; }
    .change-bar .added-bar { background: var(--added); }
    .change-bar .removed-bar { background: var(--removed); }
    .summary-note { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; white-space: nowrap; }
    .review-layout { display: grid; grid-template-columns: 238px minmax(0, 1fr); align-items: start; }
    .file-sidebar {
        position: sticky;
        top: var(--header-height);
        max-height: calc(100vh - var(--header-height));
        overflow-y: auto;
        padding: 22px 14px;
        scrollbar-width: thin;
    }
    .sidebar-heading { display: flex; align-items: center; justify-content: space-between; padding: 0 8px; margin-bottom: 13px; }
    .sidebar-heading h2 { margin: 0; font-size: 12px; font-weight: 600; }
    .count-badge { padding: 0 6px; border-radius: 4px; background: var(--hover); color: var(--muted); font: 11px/20px var(--mono); }
    .search-box { position: relative; display: flex; align-items: center; margin: 0 4px 14px; }
    .search-box > .icon { position: absolute; left: 9px; color: var(--muted); pointer-events: none; width: 14px; height: 14px; }
    .search-box input {
        width: 100%;
        min-width: 0;
        border: 1px solid var(--vscode-input-border, var(--border));
        border-radius: 5px;
        padding: 6px 10px 6px 30px;
        background: var(--vscode-input-background, var(--page));
        color: var(--vscode-input-foreground, var(--text));
        font-size: 12px;
    }
    input::placeholder, textarea::placeholder { color: var(--vscode-input-placeholderForeground, var(--muted)); }
    .file-list { display: flex; flex-direction: column; gap: 3px; }
    .file-link {
        display: flex;
        align-items: center;
        gap: 9px;
        width: 100%;
        padding: 9px 8px;
        border: 1px solid transparent;
        border-radius: 5px;
        color: var(--text);
        text-decoration: none;
    }
    .file-link:hover { background: var(--hover); }
    .file-link[aria-current='true'] { background: var(--vscode-list-inactiveSelectionBackground, #eaf1fa); border-color: var(--vscode-contrastActiveBorder, transparent); }
    .file-link[aria-current='true'] .nav-filename { color: var(--accent); }
    .nav-file-label { flex: 1; min-width: 0; line-height: 1.45; }
    .nav-filename, .nav-directory { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nav-filename { font-size: 12px; font-weight: 500; }
    .nav-directory { color: var(--muted); font-size: 10px; }
    .file-status { font: 10px/18px var(--mono); color: var(--muted); text-align: center; min-width: 18px; }
    .status-added { color: var(--added); }
    .status-deleted { color: var(--removed); }
    .status-modified, .status-renamed { color: var(--vscode-gitDecoration-modifiedResourceForeground, #9a6700); }
    .sidebar-footer { border-top: 1px solid var(--border); margin: 18px 8px 0; padding-top: 14px; color: var(--muted); font-size: 11px; }
    .content { min-width: 0; padding: 18px 28px 56px 24px; border-left: 1px solid var(--border); min-height: calc(100vh - var(--header-height)); }
    .content-toolbar { justify-content: space-between; margin-bottom: 14px; min-height: 30px; flex-wrap: wrap; gap: 8px; }
    .content-toolbar h2 { margin: 0; font-size: 13px; font-weight: 600; }
    .toolbar-actions { gap: 10px; }
    .view-label { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
    .file-diff { border: 1px solid var(--border); border-radius: 7px; margin-bottom: 20px; overflow: hidden; scroll-margin-top: calc(var(--header-height) + 16px); }
    .file-header { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 9px 12px; background: var(--surface); }
    .file-header h3 { flex: 1; min-width: 0; margin: 0; font-size: 12px; font-weight: 500; }
    .file-header-title { border: 0; padding: 0; background: transparent; text-align: left; font: 12px/1.6 var(--mono); overflow-wrap: anywhere; }
    .file-header-title:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
    .file-directory { color: var(--muted); }
    .file-name { font-weight: 600; }
    .file-stats { gap: 9px; flex-shrink: 0; font: 11px/1.5 var(--mono); }
    .icon-button { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border: 0; border-radius: 4px; background: transparent; color: var(--muted); flex-shrink: 0; padding: 4px; }
    .file-toggle .icon { transition: transform .15s; }
    .file-toggle[aria-expanded='false'] .icon { transform: rotate(-90deg); }
    .file-body { border-top: 1px solid var(--border); }
    .diff-table { width: 100%; table-layout: fixed; border-collapse: collapse; font: 12px/22px var(--mono); }
    .diff-gutter { width: 48px; }
    .diff-line-num { vertical-align: top; padding: 0 8px; text-align: right; color: var(--vscode-editorLineNumber-foreground, #7c8794); user-select: none; font-size: 11px; border-right: 1px solid var(--border); }
    .diff-line-content { position: relative; padding: 0 14px 0 26px; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4; }
    .diff-line-addition { background: var(--added-bg); }
    .diff-line-deletion { background: var(--removed-bg); }
    .diff-line-addition .diff-line-content::before, .diff-line-deletion .diff-line-content::before { position: absolute; left: 9px; top: 0; user-select: none; }
    .diff-line-addition .diff-line-content::before { content: '+'; color: var(--added); }
    .diff-line-deletion .diff-line-content::before { content: '−'; color: var(--removed); }
    .diff-hunk-header { padding: 7px 14px; text-align: left; overflow-wrap: anywhere; font-weight: 400; font-size: 11px; color: var(--muted); background: var(--vscode-diffEditor-unchangedRegionBackground, #f3f6fa); }
    .diff-line-wrapper { position: relative; min-height: 22px; }
    .add-comment-button { position: absolute; top: 1px; left: -7px; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 4px; background: var(--vscode-button-background, #0969da); color: var(--vscode-button-foreground, #fff); opacity: 0; font: 16px/20px sans-serif; }
    .diff-line:hover .add-comment-button, .add-comment-button:focus-visible { opacity: 1; }
    .empty-diff { padding: 68px 20px; text-align: center; color: var(--muted); }
    .empty-icon { width: 46px; height: 46px; border: 1px solid var(--border); border-radius: 50%; display: grid; place-items: center; margin: 0 auto 18px; color: var(--added); background: var(--surface); }
    .empty-diff h2 { color: var(--text); font-size: 17px; font-weight: 600; margin: 0 0 6px; }
    .empty-diff p { margin: 0 0 16px; }
    .no-changes { padding: 30px 16px; text-align: center; color: var(--muted); font-size: 12px; }
    .comment-thread-row > td, .comment-form-row > td { padding: 0; background: var(--page); }
    .comment-thread-container, .comment-form-container { margin: 14px 20px 14px 96px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; font-family: var(--vscode-font-family, 'Segoe UI', sans-serif); }
    .comment-thread-header { display: block; width: 100%; padding: 8px 12px; border: 0; border-bottom: 1px solid var(--border); text-align: left; background: var(--surface); color: var(--muted); font-size: 11px; }
    .comment-thread-header:hover { background: var(--hover); }
    .comment-thread-toggle { display: inline-block; margin-right: 7px; font-size: 9px; }
    .comment-thread-collapsed .comment-thread-body { display: none; }
    .comment-thread-collapsed .comment-thread-header { border-bottom: 0; }
    .comment-thread-collapsed .comment-thread-toggle { transform: rotate(-90deg); }
    .comment-item, .comment-form { display: flex; gap: 10px; padding: 14px; }
    .comment-item + .comment-item { border-top: 1px solid var(--border); }
    .comment-item { scroll-margin-top: calc(var(--header-height) + 16px); }
    .comment-item.comment-highlight { background: var(--hover); box-shadow: inset 3px 0 var(--accent); }
    .comment-avatar, .comment-form-avatar { flex-shrink: 0; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: var(--hover); color: var(--accent); font: 600 10px/1 sans-serif; }
    .comment-body, .comment-form-body { flex: 1; min-width: 0; }
    .comment-header { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; margin-bottom: 5px; }
    .comment-author { font-weight: 600; }
    .comment-timestamp { color: var(--muted); }
    .comment-content { font-size: 12px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
    .comment-actions-menu { display: flex; gap: 10px; margin-top: 9px; }
    .comment-action-btn { border: 0; border-radius: 3px; background: transparent; color: var(--muted); padding: 1px 3px; font-size: 11px; }
    .comment-action-btn[data-delete-comment]:hover { color: var(--removed); }
    .comment-textarea { display: block; width: 100%; min-height: 90px; resize: vertical; padding: 10px; border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 5px; background: var(--vscode-input-background, var(--page)); color: var(--vscode-input-foreground, var(--text)); font-size: 12px; line-height: 1.6; }
    .comment-form-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; margin-top: 10px; }
    .comment-form-hint { margin-right: auto; color: var(--muted); font-size: 10px; }
    .comment-item.deleting { opacity: .5; pointer-events: none; }
    .comment-item.deleted { display: none; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 900px) {
        .page-header { padding: 18px 20px 0; }
        .review-layout { grid-template-columns: 200px minmax(0, 1fr); }
        .content { padding: 16px 18px 40px; }
        .file-sidebar { padding: 18px 10px; }
        .comparison-note, .summary-note { display: none; }
        .file-stats .change-bar { display: none; }
        .comment-thread-container, .comment-form-container { margin: 12px; }
    }
    @media (max-width: 640px) {
        .page-header { padding: 16px 14px 0; }
        .header-top { gap: 10px; }
        .heading { gap: 10px; }
        .brand-mark { width: 32px; height: 32px; }
        h1 { font-size: 19px; }
        .header-actions { gap: 4px; }
        .header-actions .button { width: 32px; padding: 6px; }
        .header-actions .button-label { display: none; }
        .comparison { margin: 15px 0; }
        .summary-counts { gap: 12px; }
        .summary-counts .change-bar { display: none; }
        .review-layout { display: block; }
        .file-sidebar { position: static; max-height: none; padding: 16px 14px 0; }
        .sidebar-heading, .file-list, .sidebar-footer { display: none; }
        .search-box { margin: 0; }
        .content { padding: 12px 14px 32px; border-left: 0; min-height: 0; }
        .view-label { display: none; }
        .file-header { gap: 7px; padding: 8px; flex-wrap: wrap; }
        .file-header h3 { flex-basis: calc(100% - 72px); }
        .file-header .file-stats { margin-left: 33px; order: 1; }
        .file-header > .file-type-icon { display: none; }
        .diff-gutter { width: 35px; }
        .diff-line-num { padding: 0 5px; font-size: 10px; }
        .diff-line-content { padding-left: 20px; padding-right: 8px; }
        .diff-line-addition .diff-line-content::before, .diff-line-deletion .diff-line-content::before { left: 6px; }
        .comment-form-hint { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
    }
    body.vscode-high-contrast .file-link[aria-current='true'], body.vscode-high-contrast-light .file-link[aria-current='true'] { border-color: var(--focus); }
`;
