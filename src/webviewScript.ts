// Shared by branch, working-directory, and single-file views.
export function getWebviewScript(currentUser: string, viewKey: string): string {
  const json = (value: string) =>
    JSON.stringify(value).replace(/</g, "\\u003c");
  return String.raw`
    const vscode = acquireVsCodeApi();
    const currentUser = ${json(currentUser)};
    const viewKey = ${json(viewKey)};
    const previousState = vscode.getState() || {};
    const saved = previousState.viewKey === viewKey ? previousState : {};
    const collapsed = new Set(saved.collapsed || []);
    const files = [...document.querySelectorAll('.file-diff')];
    const links = [...document.querySelectorAll('.file-link')];
    const search = document.getElementById('file-search');
    const collapseAll = document.getElementById('collapse-all');
    const reloadButton = document.getElementById('reload-diff-btn');
    const status = document.getElementById('review-status');
    let scrollTimer;
    let scrollFrame;

    function saveState() {
        vscode.setState({ viewKey, collapsed: [...collapsed], filter: search.value, scrollY: window.scrollY });
    }

    function setCollapsed(file, value) {
        file.querySelector('.file-body').hidden = value;
        const toggle = file.querySelector('.file-toggle');
        toggle.setAttribute('aria-expanded', String(!value));
        toggle.setAttribute('aria-label', (value ? 'Expand ' : 'Collapse ') + file.dataset.filePath);
        if (value) collapsed.add(file.dataset.filePath);
        else collapsed.delete(file.dataset.filePath);
    }

    function updateCollapseButton() {
        const visibleFiles = files.filter(file => !file.hidden);
        const allCollapsed = visibleFiles.length > 0 && visibleFiles.every(file => file.querySelector('.file-body').hidden);
        collapseAll.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
        collapseAll.disabled = visibleFiles.length === 0;
    }

    function filterFiles() {
        const query = search.value.trim().toLowerCase();
        files.forEach(file => { file.hidden = !file.dataset.filePath.toLowerCase().includes(query); });
        links.forEach(link => { link.hidden = !link.dataset.filePath.toLowerCase().includes(query); });
        const count = files.filter(file => !file.hidden).length;
        document.getElementById('visible-files').textContent = query
            ? count + ' of ' + files.length + ' files'
            : 'Changed files';
        document.getElementById('no-matches').hidden = count > 0 || files.length === 0;
        status.textContent = query ? count + ' matching file' + (count === 1 ? '' : 's') : '';
        updateCollapseButton();
        updateActiveFile();
        saveState();
    }

    function updateActiveFile() {
        const top = document.querySelector('.page-header').getBoundingClientRect().bottom + 24;
        const visibleFiles = files.filter(file => !file.hidden);
        const active = visibleFiles.find(file => file.getBoundingClientRect().bottom > top);
        links.forEach(link => {
            if (active && link.dataset.filePath === active.dataset.filePath) link.setAttribute('aria-current', 'true');
            else link.removeAttribute('aria-current');
        });
    }

    files.forEach(file => setCollapsed(file, collapsed.has(file.dataset.filePath)));
    search.value = saved.filter || '';
    filterFiles();
    search.addEventListener('input', filterFiles);
    document.getElementById('clear-filter').addEventListener('click', () => {
        search.value = '';
        filterFiles();
        search.focus();
    });
    search.addEventListener('keydown', event => {
        if (event.key === 'Escape') { search.value = ''; filterFiles(); }
    });
    collapseAll.addEventListener('click', () => {
        const visibleFiles = files.filter(file => !file.hidden);
        const shouldCollapse = visibleFiles.some(file => !file.querySelector('.file-body').hidden);
        visibleFiles.forEach(file => setCollapsed(file, shouldCollapse));
        updateCollapseButton();
        saveState();
    });

    links.forEach(link => link.addEventListener('click', event => {
        event.preventDefault();
        const file = document.getElementById(link.getAttribute('href').slice(1));
        if (!file) return;
        setCollapsed(file, false);
        updateCollapseButton();
        file.scrollIntoView({ block: 'start', behavior: 'auto' });
        file.querySelector('.file-toggle').focus({ preventScroll: true });
        updateActiveFile();
        saveState();
    }));

    new ResizeObserver(entries => {
        document.documentElement.style.setProperty('--header-height', entries[0].target.offsetHeight + 'px');
    }).observe(document.querySelector('.page-header'));
    requestAnimationFrame(() => {
        window.scrollTo(0, saved.scrollY || 0);
        updateActiveFile();
    });
    window.addEventListener('scroll', () => {
        if (!scrollFrame) scrollFrame = requestAnimationFrame(() => { updateActiveFile(); scrollFrame = null; });
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(saveState, 150);
    }, { passive: true });

    function setButtonLabel(button, label) {
        button.querySelector('.button-label').textContent = label;
        button.setAttribute('aria-label', label);
    }

    function reloadDiff() {
        if (!reloadButton || reloadButton.disabled) return;
        saveState();
        reloadButton.disabled = true;
        reloadButton.classList.add('loading');
        setButtonLabel(reloadButton, 'Refreshing…');
        status.textContent = 'Refreshing changes';
        vscode.postMessage({ command: 'reload' });
    }
    if (reloadButton) reloadButton.addEventListener('click', reloadDiff);
    const copyButton = document.getElementById('copy-comments-btn');
    if (copyButton) copyButton.addEventListener('click', () => {
        vscode.postMessage({ command: 'copyComments' });
    });

    function getComment(id) {
        return document.querySelector('[data-comment-id="' + CSS.escape(id) + '"]');
    }

    function createCommentForm(content, onSubmit, onCancel, submitLabel) {
        const form = document.createElement('div');
        form.innerHTML = '<textarea class="comment-textarea" aria-label="Comment" placeholder="Leave a comment…"></textarea>' +
            '<div class="comment-form-actions"><span class="comment-form-hint">Ctrl / ⌘ + Enter to save</span>' +
            '<button class="button comment-cancel-btn" data-cancel-comment>Cancel</button>' +
            '<button class="button primary comment-submit-btn" data-submit-comment></button></div>';
        const textarea = form.querySelector('textarea');
        const submit = form.querySelector('[data-submit-comment]');
        const cancel = form.querySelector('[data-cancel-comment]');
        textarea.value = content;
        submit.textContent = submitLabel;
        submit.disabled = !content.trim();
        const send = () => {
            if (!textarea.value.trim() || submit.disabled) return;
            submit.disabled = true;
            cancel.disabled = true;
            textarea.disabled = true;
            submit.textContent = 'Saving…';
            saveState();
            onSubmit(textarea.value.trim());
        };
        textarea.addEventListener('input', () => {
            submit.disabled = !textarea.value.trim();
            textarea.style.height = 'auto';
            textarea.style.height = Math.max(90, textarea.scrollHeight) + 'px';
        });
        textarea.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); send(); }
            if (event.key === 'Escape' && !cancel.disabled) { event.preventDefault(); onCancel(); }
        });
        submit.addEventListener('click', send);
        cancel.addEventListener('click', onCancel);
        return form;
    }

    function showCommentForm(button) {
        const targetRow = button.closest('tr.diff-line');
        if (!targetRow) return;
        const existingForm = document.querySelector('.comment-form-row');
        if (existingForm) existingForm.remove();
        const formRow = document.createElement('tr');
        formRow.className = 'comment-form-row';
        formRow.innerHTML = '<td colspan="3"><div class="comment-form-container"><div class="comment-form">' +
            '<div class="comment-form-avatar" aria-hidden="true"></div><div class="comment-form-body"></div></div></div></td>';
        formRow.querySelector('.comment-form-avatar').textContent = currentUser.split(' ').map(name => name.charAt(0).toUpperCase()).join('').slice(0, 2);
        const form = createCommentForm('', content => vscode.postMessage({
            command: 'addComment', filePath: button.dataset.filePath,
            lineNumber: Number(button.dataset.lineNumber), lineType: button.dataset.lineType, content
        }), () => { formRow.remove(); button.focus(); }, 'Comment');
        formRow.querySelector('.comment-form-body').appendChild(form);
        targetRow.after(formRow);
        form.querySelector('textarea').focus();
    }

    function editComment(id) {
        const item = getComment(id);
        if (!item || item.querySelector('textarea')) return;
        const content = item.querySelector('.comment-content');
        const actions = item.querySelector('.comment-actions-menu');
        const original = content.textContent;
        actions.hidden = true;
        const form = createCommentForm(original, value => vscode.postMessage({ command: 'editComment', commentId: id, content: value }), () => {
            content.textContent = original;
            actions.hidden = false;
            actions.querySelector('[data-edit-comment]').focus();
        }, 'Save comment');
        content.replaceChildren(form);
        form.querySelector('textarea').focus();
    }

    document.addEventListener('click', event => {
        const target = event.target.closest('button');
        if (!target) return;
        if (target.classList.contains('file-toggle')) {
            const file = target.closest('.file-diff');
            setCollapsed(file, !file.querySelector('.file-body').hidden);
            updateCollapseButton();
            saveState();
        } else if (target.hasAttribute('data-open-file')) {
            vscode.postMessage({ command: 'openFile', filePath: target.dataset.openFile });
        } else if (target.classList.contains('add-comment-button')) {
            showCommentForm(target);
        } else if (target.hasAttribute('data-toggle-thread')) {
            const thread = target.closest('.comment-thread-container');
            thread.classList.toggle('comment-thread-collapsed');
            target.setAttribute('aria-expanded', String(!thread.classList.contains('comment-thread-collapsed')));
        } else if (target.hasAttribute('data-edit-comment')) {
            editComment(target.dataset.editComment);
        } else if (target.hasAttribute('data-copy-comment')) {
            vscode.postMessage({ command: 'copySingleComment', comment: JSON.parse(target.dataset.copyComment) });
        } else if (target.hasAttribute('data-delete-comment')) {
            const item = getComment(target.dataset.deleteComment);
            if (item) item.classList.add('deleting');
            saveState();
            vscode.postMessage({ command: 'deleteComment', commentId: target.dataset.deleteComment });
        }
    });

    window.addEventListener('message', event => {
        const message = event.data;
        if (message.command === 'reloadComplete' && reloadButton) {
            reloadButton.disabled = false;
            reloadButton.classList.remove('loading');
            setButtonLabel(reloadButton, 'Refresh');
            status.textContent = message.success ? 'Changes refreshed' : 'Refresh failed. Try again.';
        }
        if (message.command === 'commentDeleted') {
            const item = getComment(message.commentId);
            if (!item) return;
            const thread = item.closest('.comment-thread-container');
            item.remove();
            const remaining = thread.querySelectorAll('.comment-item').length;
            if (!remaining) thread.closest('tr').remove();
            else thread.querySelector('.thread-count').textContent = remaining + ' comment' + (remaining === 1 ? '' : 's');
            if (copyButton) {
                const count = document.querySelectorAll('.comment-item').length;
                copyButton.querySelector('.comment-count').textContent = String(count);
                copyButton.disabled = count === 0;
            }
        }
    });

    let lastFocusTime = Date.now();
    let reloadTimer;
    function handleAutoReload() {
        clearTimeout(reloadTimer);
        const now = Date.now();
        if (now - lastFocusTime > 5000 && !document.querySelector('.comment-textarea')) {
            reloadTimer = setTimeout(reloadDiff, 500);
        }
        lastFocusTime = now;
    }
    window.addEventListener('focus', handleAutoReload);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) handleAutoReload(); });
  `;
}
