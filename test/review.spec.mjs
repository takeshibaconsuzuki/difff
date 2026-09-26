import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const css = await readFile(new URL('../dist/review.css', import.meta.url), 'utf8');
const js = await readFile(new URL('../dist/review.js', import.meta.url), 'utf8');
const contextBundle = (await build({ entryPoints: ['src/context.ts'], bundle: true, platform: 'browser', format: 'iife', globalName: 'ContextAPI', write: false })).outputFiles[0].text;
const file = {
  path: 'src/review.ts', status: 'M', additions: 2, deletions: 1, snapshot: 'fixture',
  gaps: [{ id: '1:1:17', before: 0, oldStart: 1, newStart: 1, count: 17 }, { id: '21:22:30', before: 1, oldStart: 21, newStart: 22, count: 30 }],
  hunks: [{ header: '@@ −18,3 +18,4 @@', oldStart: 18, oldLines: 3, newStart: 18, newLines: 4, lines: [
    { kind: 'context', text: 'export async function loadReview(scope: Scope) {', oldLine: 18, newLine: 18 },
    { kind: 'delete', text: '  const files = await git.diff();', oldLine: 19 },
    { kind: 'add', text: '  const files = await git.diff(scope);', newLine: 19 },
    { kind: 'add', text: '  return files.filter(isReviewable);', newLine: 20 },
    { kind: 'context', text: '}', oldLine: 20, newLine: 21 },
  ] }],
};
const seed = {
  repositories: [{ root: '/workspace/difff', name: 'difff' }], repository: '/workspace/difff', branch: 'feature/local-review', scope: 'uncommitted',
  files: [file, { ...file, path: 'src/components/toolbar.ts', status: 'A', additions: 4, deletions: 0 }, { ...file, path: 'README.md', additions: 2, deletions: 1 }],
  comments: [{ id: 'existing', repository: '/workspace/difff', path: 'src/review.ts', line: 19, side: 'new', code: '  const files = await git.diff(scope);', scope: 'uncommitted', body: 'Could we keep untracked files in this view too? It would make the full review easier to follow.', createdAt: '2026-01-01' }],
};

async function mount(page, initial = seed) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('http://difff.test/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/host') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><button id="outside">Outside review</button><iframe title="Review" src="/" width="1400" height="850"></iframe></body></html>' });
    if (pathname === '/review.js') return route.fulfill({ contentType: 'text/javascript', body: js });
    if (pathname === '/review.css') return route.fulfill({ contentType: 'text/css', body: `body { padding: 0 20px; } code { background: rgba(127, 127, 127, .3); padding: 2px 4px; } ::-webkit-scrollbar-thumb { background: #444; } ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: #222; }\n${css}` });
    if (pathname === '/context.js') return route.fulfill({ contentType: 'text/javascript', body: contextBundle });
    return route.fulfill({ contentType: 'text/html', body: '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'self\'; script-src \'nonce-test\'; worker-src blob:;"><link rel="stylesheet" href="/review.css"></head><body class="vscode-dark"><div id="app"></div><script nonce="test" src="/context.js"></script><script nonce="test" src="/review.js"></script></body></html>' });
  });
  await page.addInitScript(initial => {
    window.reviewState = initial;
    window.messages = [];
    window.localState = JSON.parse(sessionStorage.getItem('difff-state') ?? '{}');
    const sources = Object.fromEntries(initial.files.map(file => {
      const lines = Array.from({ length: file.totalOldLines ?? 50 }, (_, index) => `context ${index + 1}`);
      for (const hunk of file.hunks) for (const line of hunk.lines) if (line.oldLine) lines[line.oldLine - 1] = line.text;
      return [file.path, lines];
    }));
    window.acquireVsCodeApi = () => ({
      getState: () => window.localState,
      setState: value => { window.localState = value; sessionStorage.setItem('difff-state', JSON.stringify(value)); },
      postMessage: message => {
        window.messages.push(message);
        if (window.heldTypes?.includes(message.type)) return;
        const state = window.reviewState;
        const emit = value => window.postMessage(value, '*');
        if (message.type === 'ready' && message.scope) state.scope = message.scope;
        if (message.type === 'ready' && message.repository) state.repository = message.repository;
        if (message.type === 'scope') { state.scope = message.scope; state.files = initial.scopeFiles?.[message.scope] ?? state.files; }
        if (message.type === 'repository') state.repository = message.root;
        if (message.type === 'comment') {
          state.comments.push({ ...message, id: 'new-comment', repository: state.repository, createdAt: '2026-01-02' });
        }
        if (message.type === 'edit') state.comments.find(comment => comment.id === message.id).body = message.body;
        if (message.type === 'delete') state.comments = state.comments.filter(comment => comment.id !== message.id);
        if (message.type === 'clear') state.comments = [];
        if (message.type === 'expand' || message.type === 'expandAll') {
          const index = state.files.findIndex(file => file.path === message.path);
          const file = state.files[index];
          state.files[index] = message.type === 'expand' ? window.ContextAPI.expandContext(file, sources[file.path], message.gap, message.direction) : window.ContextAPI.expandAllContext(file, sources[file.path]);
        }
        if (message.type === 'copy') emit({ type: 'notice', text: `${state.comments.length} comments copied with source locations.` });
        if (message.type === 'jump') emit({ type: 'reveal', comment: state.comments.find(comment => comment.id === message.id) });
        else { emit({ type: 'state', state }); emit({ type: 'busy', busy: false }); }
        if (message.type === 'comment' || message.type === 'edit') emit({ type: 'saved' });
      },
    });
  }, initial);
  await page.goto('http://difff.test');
  await expect(page.getByRole('main', { name: 'Diff review' })).toHaveAttribute('aria-busy', 'false');
  expect(errors).toEqual([]);
  return errors;
}

for (const trigger of ['scope button', 'comment jump']) {
  test(`${trigger} immediately clears all views during a scope switch and ignores late state`, async ({ page }) => {
    const data = structuredClone(seed);
    data.comments[0].scope = 'staged';
    await mount(page, data);
    await page.getByRole('textbox', { name: 'Filter files' }).fill('review');
    await page.getByRole('textbox', { name: 'Find in diff' }).fill('git');
    await expect(page.locator('mark')).not.toHaveCount(0);
    await page.evaluate(() => { window.heldTypes = ['scope', 'jump']; });
    if (trigger === 'scope button') await page.locator('[data-scope="staged"]').click();
    else await page.locator('.comment-card').getByRole('button', { name: 'Jump to comment' }).click();

    await expect(page.locator('#diff')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('[data-scope="staged"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.file-link, .file-card, .comment-card, .add-comment, mark')).toHaveCount(0);
    await expect(page.locator('.diff-empty, .comments-empty')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Filter files' })).toHaveValue('');
    await expect(page.locator('#search-count')).toHaveText('0/0');
    await expect(page.getByRole('button', { name: 'Clear all', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Copy comments', exact: true })).toBeDisabled();

    await page.evaluate(() => {
      window.postMessage({ type: 'state', state: window.reviewState }, '*');
      window.postMessage({ type: 'reveal', comment: window.reviewState.comments[0] }, '*');
      window.postMessage({ type: 'busy', busy: false }, '*');
    });
    await expect(page.locator('#diff')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('[data-scope="staged"]')).toBeDisabled();
    await expect(page.locator('.file-link, .file-card, .comment-card')).toHaveCount(0);
    await expect(page.locator('#notice')).toBeHidden();
    expect(await page.evaluate(() => window.localState.draft)).toBeUndefined();

    await page.evaluate(trigger => {
      const state = window.reviewState;
      state.scope = 'staged';
      state.files = [state.files[0]];
      window.postMessage({ type: 'state', state }, '*');
      if (trigger === 'comment jump') window.postMessage({ type: 'reveal', comment: state.comments[0] }, '*');
      window.postMessage({ type: 'busy', busy: false }, '*');
    }, trigger);
    await expect(page.locator('#diff')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.file-link')).toHaveCount(1);
    await expect(page.locator('.file-card')).toHaveCount(1);
    await expect(page.locator('.comment-card')).toHaveCount(1);
    if (trigger === 'comment jump') await expect(page.locator('.diff-line.flash')).toHaveCount(1);
    await page.getByRole('button', { name: 'Comment on src/review.ts:20', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.localState.draft?.scope)).toBe('staged');
  });
}

test('file arrows open existing and conflicted files but are absent on deleted files in every scope', async ({ page }) => {
  const data = structuredClone(seed);
  data.files = [
    { ...file, path: 'existing.txt' },
    { ...file, path: 'deleted.txt', status: 'D' },
    { ...file, path: 'conflicted.txt', status: 'U' },
  ];
  data.comments = [];
  await mount(page, data);
  for (const scope of ['uncommitted', 'staged', 'unstaged']) {
    await page.locator(`[data-scope="${scope}"]`).click();
    await expect(page.locator('#diff')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.file-card[data-path="deleted.txt"] .open-file')).toHaveCount(0);
    for (const path of ['existing.txt', 'conflicted.txt']) {
      await page.locator(`.file-card[data-path="${path}"]`).getByRole('button', { name: 'Open file in editor' }).click();
      expect(await page.evaluate(() => window.messages.filter(message => message.type === 'open').at(-1))).toEqual({ type: 'open', path, line: 1 });
    }
  }
});

test('repository switches immediately clear all views and ignore late state from the previous repository', async ({ page }) => {
  const data = structuredClone(seed);
  data.repositories.push({ root: '/workspace/other', name: 'other' });
  await mount(page, data);
  await page.getByRole('textbox', { name: 'Filter files' }).fill('review');
  await page.evaluate(() => { window.heldTypes = ['repository']; });
  await page.getByRole('combobox', { name: 'Repository' }).selectOption('/workspace/other');
  await expect(page.locator('#diff')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.file-link')).toHaveCount(0);
  await expect(page.locator('.file-card')).toHaveCount(0);
  await expect(page.locator('.comment-card')).toHaveCount(0);
  await expect(page.locator('.diff-empty, .comments-empty')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Filter files' })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Clear all', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Copy comments', exact: true })).toBeDisabled();

  await page.evaluate(() => {
    window.postMessage({ type: 'state', state: window.reviewState }, '*');
    window.postMessage({ type: 'busy', busy: false }, '*');
  });
  await expect(page.getByRole('combobox', { name: 'Repository' })).toHaveValue('/workspace/other');
  await expect(page.getByRole('combobox', { name: 'Repository' })).toBeDisabled();
  await expect(page.locator('.file-card, .comment-card')).toHaveCount(0);
  await page.evaluate(() => {
    const state = window.reviewState;
    state.repository = '/workspace/other';
    state.comments = [{ ...state.comments[0], id: 'other-comment', repository: state.repository, body: 'Comment from the new repository.' }];
    state.files = [{ ...state.files[0], path: 'other.txt' }];
    window.postMessage({ type: 'state', state }, '*');
    window.postMessage({ type: 'busy', busy: false }, '*');
  });
  await expect(page.locator('#diff')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.file-link')).toHaveCount(1);
  await expect(page.locator('.file-link')).toContainText('other.txt');
  await expect(page.locator('.comment-card')).toHaveCount(1);
  await expect(page.locator('.comment-card')).toContainText('Comment from the new repository.');
  await expect(page.getByRole('button', { name: 'Clear all', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.messages.some(message => message.type === 'clear'))).toBe(false);
});

for (const edit of [false, true]) {
  test(`saving ${edit ? 'an edit' : 'a new comment'} immediately locks editing until success or failure`, async ({ page }) => {
    await mount(page);
    await page.evaluate(() => { window.heldTypes = ['comment', 'edit']; });
    if (edit) await page.locator('.inline-comment').getByRole('button', { name: 'Edit comment' }).click();
    else await page.getByRole('button', { name: 'Comment on src/review.ts:20', exact: true }).click();
    const textarea = page.getByRole('textbox', { name: edit ? 'Edit comment' : 'Write a comment' });
    await textarea.fill('Keep this text while saving.');
    await page.getByRole('button', { name: 'Save comment', exact: true }).click();
    await expect(textarea).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Cancel comment' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save comment', exact: true })).toBeDisabled();
    for (const button of await page.locator('.add-comment, .comment-actions button:not([title="Focus comment in panel"])').all()) {
      await expect(button).toBeDisabled();
    }
    await expect(page.getByRole('button', { name: 'Clear all', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(textarea).toHaveValue('Keep this text while saving.');
    // A previous request completing must not unlock this pending save.
    await page.evaluate(() => { window.postMessage({ type: 'busy', busy: false }, '*'); });
    await expect(textarea).toBeDisabled();
    await expect.poll(() => page.evaluate(() => window.localState.draft?.body)).toBe('Keep this text while saving.');

    await page.evaluate(() => {
      window.postMessage({ type: 'notice', text: 'Unable to save.', error: true }, '*');
      window.postMessage({ type: 'saveFailed' }, '*');
      window.postMessage({ type: 'busy', busy: false }, '*');
    });
    await expect(textarea).toBeEnabled();
    await expect(textarea).toHaveValue('Keep this text while saving.');
    await textarea.fill('Retry this comment.');
    await textarea.press('Control+Enter');
    await expect(textarea).toBeDisabled();
    await page.evaluate(() => {
      window.postMessage({ type: 'saved' }, '*');
      window.postMessage({ type: 'busy', busy: false }, '*');
    });
    await expect(textarea).toHaveCount(0);
    await expect(page.locator('.add-comment').first()).toBeEnabled();
    await expect.poll(() => page.evaluate(() => window.localState.draft)).toBeUndefined();
    expect(await page.evaluate(() => window.messages.filter(message => message.type === 'comment' || message.type === 'edit').length)).toBe(2);
  });
}

test('line comments support create, edit, jump, copy, delete, and clear', async ({ page }) => {
  await mount(page);
  await page.getByRole('button', { name: 'Comment on src/review.ts:20', exact: true }).click();
  await page.getByRole('textbox', { name: 'Write a comment' }).fill('Add a test for an empty repository.');
  await page.getByRole('button', { name: 'Save comment', exact: true }).click();
  await expect(page.locator('.comment-card')).toHaveCount(2);
  await page.locator('.comment-card').last().getByRole('button', { name: 'Edit comment' }).click();
  await page.getByRole('textbox', { name: 'Edit comment' }).fill('Add an empty-repository regression test.');
  await page.getByRole('textbox', { name: 'Edit comment' }).press('Control+Enter');
  await expect(page.locator('.comment-card').last()).toContainText('Add an empty-repository regression test.');
  await page.locator('.comment-card').last().getByRole('button', { name: 'Jump to comment' }).click();
  await expect(page.locator('.diff-line.flash')).toHaveCount(1);
  await page.getByRole('button', { name: /Copy comments/ }).click();
  await expect(page.getByRole('status').filter({ hasText: '2 comments copied' })).toBeVisible();
  await page.locator('.comment-card').last().getByRole('button', { name: 'Delete comment' }).click();
  await expect(page.locator('.comment-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear all', exact: true }).click();
  await page.getByRole('button', { name: 'Keep comments' }).click();
  await expect(page.locator('.comment-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear all', exact: true }).click();
  await page.getByRole('button', { name: 'Clear all comments', exact: true }).click();
  await expect(page.locator('.comment-card')).toHaveCount(0);
});

test('scopes, regex search, context, and file navigation are wired', async ({ page }) => {
  await mount(page);
  await page.locator('[data-scope="staged"]').click();
  await expect(page.locator('[data-scope="staged"]')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('textbox', { name: 'Find in diff' }).fill('git\\.diff\\(scope\\)');
  await page.getByRole('button', { name: 'Use regular expression' }).click();
  await expect(page.locator('#search-count')).toHaveText('1/3');
  await page.getByRole('button', { name: 'Next match', exact: true }).click();
  await expect(page.locator('#search-count')).toHaveText('2/3');
  await expect(page.locator('mark.active-mark')).toHaveAttribute('data-match', '1');
  await page.getByRole('textbox', { name: 'Find in diff' }).fill('[');
  await expect(page.locator('#search-error')).toContainText('Invalid regular expression');
  await page.getByRole('textbox', { name: 'Find in diff' }).press('Escape');
  await page.getByRole('button', { name: 'Show 17 lines above' }).first().click();
  await expect.poll(() => page.evaluate(() => window.messages.some(message => message.type === 'expand'))).toBe(true);
  await page.getByRole('textbox', { name: 'Filter files' }).fill('toolbar');
  await expect(page.locator('.file-link')).toHaveCount(1);
  await page.locator('.file-link').click();
  await expect(page.locator('.file-link')).toHaveAttribute('aria-current', 'true');
  await page.getByRole('button', { name: 'Open file in editor' }).nth(1).click();
  await expect.poll(() => page.evaluate(() => window.messages.at(-1).type)).toBe('open');
});

test('review shortcuts focus and select their inputs without bubbling to VS Code', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 850 });
  await mount(page);
  // The VS Code webview forwards keyboard events from a listener on window.
  await page.evaluate(() => {
    window.forwardedKeys = [];
    window.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && ['p', 'f'].includes(event.key.toLowerCase())) {
        window.forwardedKeys.push({ key: event.key.toLowerCase(), shift: event.shiftKey, alt: event.altKey });
      }
    });
  });
  const files = page.getByRole('textbox', { name: 'Filter files' });
  const find = page.getByRole('textbox', { name: 'Find in diff' });
  await expect(files).toBeHidden();
  for (const modifier of ['Control', 'Meta']) {
    await page.locator('#diff').focus();
    await page.keyboard.press(`${modifier}+p`);
    await expect(files).toBeVisible();
    await expect(files).toBeFocused();
    await files.fill('review');
    await page.keyboard.press(`${modifier}+f`);
    await expect(find).toBeFocused();
    await find.fill('git');
    // Refocusing must work even when the file pane is already open.
    await page.keyboard.press(`${modifier}+p`);
    await expect(files).toBeFocused();
    expect(await files.evaluate(node => node.value.slice(node.selectionStart, node.selectionEnd))).toBe('review');
    await page.keyboard.press(`${modifier}+f`);
    await expect(find).toBeFocused();
    expect(await find.evaluate(node => node.value.slice(node.selectionStart, node.selectionEnd))).toBe('git');
  }
  expect(await page.evaluate(() => window.forwardedKeys)).toEqual([]);
  await page.locator('#diff').focus();
  await page.keyboard.press('Control+Shift+p');
  await page.keyboard.press('Control+Shift+f');
  await page.keyboard.press('Control+Alt+p');
  await expect(page.locator('#diff')).toBeFocused();
  expect(await page.evaluate(() => window.forwardedKeys)).toEqual([
    { key: 'p', shift: true, alt: false },
    { key: 'f', shift: true, alt: false },
    { key: 'p', shift: false, alt: true },
  ]);
});

test('file selection and refresh preserve the file list scroll position', async ({ page }) => {
  const data = structuredClone(seed);
  data.files = Array.from({ length: 70 }, (_, index) => ({ ...file, path: `src/part-${String(index).padStart(3, '0')}.ts` }));
  data.comments = [];
  await mount(page, data);
  const target = page.locator('.file-link').nth(50);
  await target.scrollIntoViewIfNeeded();
  const scrollTop = await page.locator('#files').evaluate(node => node.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  await target.click();
  await expect(target).toHaveAttribute('aria-current', 'true');
  await expect(target).toBeFocused();
  await expect.poll(() => page.locator('#diff').evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  expect(await page.locator('#files').evaluate(node => node.scrollTop)).toBe(scrollTop);
  await page.getByRole('button', { name: 'Refresh changes' }).click();
  await expect.poll(() => page.evaluate(() => window.messages.at(-1).type)).toBe('refresh');
  expect(await page.locator('#files').evaluate(node => node.scrollTop)).toBe(scrollTop);
});

test('inline comments can be edited and deleted without opening the sidebar', async ({ page }) => {
  await mount(page);
  await page.locator('#toggle-comments').click();
  await expect(page.locator('#comments-pane')).toBeHidden();
  const inline = page.locator('.inline-comment');
  await inline.getByRole('button', { name: 'Edit comment' }).click();
  await page.getByRole('textbox', { name: 'Edit comment' }).fill('Updated here, beside the source.');
  await page.getByRole('button', { name: 'Save comment', exact: true }).click();
  await expect(inline).toContainText('Updated here, beside the source.');
  await expect(page.locator('#comments-pane')).toBeHidden();
  await inline.getByRole('button', { name: 'Delete comment' }).click();
  await expect(inline).toHaveCount(0);
  await expect(page.locator('#comment-count')).toHaveText('0');
  await expect(page.locator('#comments-pane')).toBeHidden();
});

test('incoming context updates preserve the active draft cursor and horizontal scroll', async ({ page }) => {
  const data = structuredClone(seed);
  data.files[0].hunks[0].lines[0].text = `const wideLine = '${'x'.repeat(240)}';`;
  const errors = await mount(page, data);
  await page.getByRole('button', { name: 'Comment on src/review.ts:20', exact: true }).click();
  const textarea = page.getByRole('textbox', { name: 'Write a comment' });
  await textarea.fill('Keep this draft and its selection.');
  await textarea.evaluate(node => { node.setSelectionRange(5, 15); });
  const table = page.locator('.code-table').first();
  await table.evaluate(node => { node.scrollLeft = 80; });
  await page.evaluate(() => {
    window.reviewState.files[0].hunks[0].lines.unshift({ kind: 'context', text: '// expanded context', oldLine: 17, newLine: 17 });
    window.postMessage({ type: 'state', state: window.reviewState }, '*');
  });
  await expect(page.getByText('// expanded context', { exact: true })).toBeVisible();
  await expect(textarea).toBeFocused();
  await expect(textarea).toHaveValue('Keep this draft and its selection.');
  expect(await textarea.evaluate(node => [node.selectionStart, node.selectionEnd])).toEqual([5, 15]);
  expect(await table.evaluate(node => node.scrollLeft)).toBe(80);
  expect(errors).toEqual([]);
});

test('a draft and its scope survive a webview reload and save once', async ({ page }) => {
  const errors = await mount(page);
  await page.locator('[data-scope="staged"]').click();
  await expect(page.locator('[data-scope="staged"]')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Comment on src/review.ts:20', exact: true }).click();
  await page.getByRole('textbox', { name: 'Write a comment' }).fill('Resume this staged review.');
  await expect.poll(() => page.evaluate(() => window.localState.draft?.body)).toBe('Resume this staged review.');
  await page.reload();
  await expect(page.getByRole('main', { name: 'Diff review' })).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-scope="staged"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: 'Write a comment' })).toHaveValue('Resume this staged review.');
  await page.getByRole('textbox', { name: 'Write a comment' }).press('Control+Enter');
  await expect(page.locator('.inline-comment')).toContainText('Resume this staged review.');
  await expect.poll(() => page.evaluate(() => window.messages.filter(message => message.type === 'comment').length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.localState.draft)).toBeUndefined();
  expect(errors).toEqual([]);
});

test('comments open on narrow panes and the repository selector only appears for multiple repositories', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 850 });
  await mount(page);
  await expect(page.locator('#comments-pane')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Repository' })).toBeHidden();
  await page.evaluate(() => {
    window.reviewState.repositories.push({ root: '/workspace/other', name: 'other' });
    window.postMessage({ type: 'state', state: window.reviewState }, '*');
  });
  const selector = page.getByRole('combobox', { name: 'Repository' });
  await expect(selector).toBeVisible();
  await selector.selectOption('/workspace/other');
  await expect.poll(() => page.evaluate(() => window.messages.at(-1))).toEqual({ type: 'repository', root: '/workspace/other' });
});

test('source and comment text are inert, drafts survive refresh, pathological regex times out', async ({ page }) => {
  const data = structuredClone(seed);
  data.comments[0].body = '<img src=x onerror=alert(1)>';
  data.files[0].hunks[0].lines[2].text = 'a'.repeat(100) + '!';
  await mount(page, data);
  await expect(page.locator('.comment-body')).toHaveText('<img src=x onerror=alert(1)>');
  await expect(page.locator('img')).toHaveCount(0);
  await page.getByRole('button', { name: 'Comment on src/review.ts:20', exact: true }).click();
  await page.getByRole('textbox', { name: 'Write a comment' }).fill('Do not lose this draft.');
  await page.getByRole('button', { name: 'Refresh changes' }).click();
  await expect(page.getByRole('textbox', { name: 'Write a comment' })).toHaveValue('Do not lose this draft.');
  await page.getByRole('button', { name: 'Cancel comment' }).click();
  await page.getByRole('button', { name: 'Use regular expression' }).click();
  await page.getByRole('textbox', { name: 'Find in diff' }).fill('(a+)+$');
  await expect(page.locator('#search-error')).toContainText('Regex took too long', { timeout: 5000 });
  await page.getByRole('textbox', { name: 'Find in diff' }).fill('loadReview');
  await expect(page.locator('#search-count')).toHaveText('1/3');
});

test('minimal layout fits dark, light, and narrow views', async ({ page }, testInfo) => {
  await mount(page);
  await page.screenshot({ path: testInfo.outputPath('review-dark.png'), fullPage: true });
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await page.screenshot({ path: testInfo.outputPath('review-light.png'), fullPage: true });
  await page.setViewportSize({ width: 700, height: 850 });
  await page.getByRole('button', { name: /Comments/ }).filter({ has: page.locator('#comment-count') }).click();
  await expect(page.locator('#comments-pane')).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('review-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 750 });
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Filter files' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Filter files' }).fill('toolbar');
  await page.locator('.file-link').click();
  await expect(page.getByRole('textbox', { name: 'Filter files' })).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('context buttons reveal only their gap and disappear at file boundaries', async ({ page }) => {
  const data = structuredClone(seed);
  data.comments = [];
  data.files = [{
    ...file, path: 'eslint.config.mjs', additions: 1, deletions: 1, totalOldLines: 35,
    gaps: [{ id: '1:1:1', before: 0, oldStart: 1, newStart: 1, count: 1 }, { id: '9:9:27', before: 1, oldStart: 9, newStart: 9, count: 27 }],
    hunks: [{ header: '@@ −2,7 +2,7 @@', oldStart: 2, oldLines: 7, newStart: 2, newLines: 7, lines: [
      ...[2, 3, 4].map(line => ({ kind: 'context', text: `line ${line}`, oldLine: line, newLine: line })),
      { kind: 'delete', text: 'line 5', oldLine: 5 }, { kind: 'add', text: 'changed line 5', newLine: 5 },
      ...[6, 7, 8].map(line => ({ kind: 'context', text: `line ${line}`, oldLine: line, newLine: line })),
    ] }],
  }];
  await mount(page, data);
  await expect(page.locator('.old-number').first()).toHaveText('2');
  await page.getByRole('button', { name: 'Show 20 lines below', exact: true }).click();
  await expect(page.locator('.old-number').first()).toHaveText('2');
  await expect(page.locator('.old-number').last()).toHaveText('28');
  await expect(page.getByRole('button', { name: 'Show 7 lines below', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show 1 line above', exact: true }).click();
  await expect(page.locator('.old-number').first()).toHaveText('1');
  await expect(page.getByRole('button', { name: /lines? above/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show 7 lines below', exact: true }).click();
  await expect(page.locator('.old-number').last()).toHaveText('35');
  await expect(page.locator('.expand')).toHaveCount(0);
  await expect(page.locator('.old-number')).toHaveCount(35);
});

test('the file header stays fixed when switching to an empty scope and badges and search icons are centered', async ({ page }, testInfo) => {
  const data = structuredClone(seed);
  data.files = Array.from({ length: 70 }, (_, i) => ({ ...file, path: `src/part-${i}.ts` }));
  data.scopeFiles = { staged: [] };
  await mount(page, data);
  const heading = page.locator('.files-pane .pane-heading');
  const beforeHeading = await heading.boundingBox();
  const beforeFilter = await page.locator('#file-filter').boundingBox();
  await page.locator('[data-scope="staged"]').click();
  await expect(page.locator('#file-count')).toHaveText('0');
  expect(await heading.boundingBox()).toEqual(beforeHeading);
  expect(await page.locator('#file-filter').boundingBox()).toEqual(beforeFilter);
  const centers = await page.locator('#file-count').evaluate(node => {
    const badge = node.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(node);
    const text = range.getBoundingClientRect();
    return { x: text.x + text.width / 2 - badge.x - badge.width / 2, y: text.y + text.height / 2 - badge.y - badge.height / 2 };
  });
  expect(Math.abs(centers.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(centers.y)).toBeLessThanOrEqual(1);
  const search = await page.locator('.search').boundingBox();
  const icon = await page.locator('.search-icon').boundingBox();
  expect(Math.abs(search.y + search.height / 2 - icon.y - icon.height / 2)).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath('empty-staged.png') });
});

test('inline actions sit below plain comment text and diff code has no injected background', async ({ page }, testInfo) => {
  await mount(page);
  const inline = page.locator('.inline-comment');
  const body = inline.locator('.inline-comment-body');
  const cardBox = await inline.boundingBox();
  const bodyBox = await body.boundingBox();
  const editBox = await inline.getByRole('button', { name: 'Edit comment' }).boundingBox();
  const deleteBox = await inline.getByRole('button', { name: 'Delete comment' }).boundingBox();
  expect(editBox.y).toBeGreaterThanOrEqual(bodyBox.y + bodyBox.height);
  expect(editBox.x - bodyBox.x).toBeLessThan(10);
  expect(deleteBox.x - editBox.x - editBox.width).toBeLessThan(8);
  expect(cardBox.width - bodyBox.width).toBeLessThan(4);
  expect(await body.evaluate(node => parseFloat(getComputedStyle(node).paddingLeft))).toBeGreaterThanOrEqual(8);
  await body.hover();
  expect(await body.evaluate(node => node.tagName)).toBe('P');
  expect(await body.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  expect(await page.locator('.line-code').first().evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await page.screenshot({ path: testInfo.outputPath('inline-hover.png') });
});

test('light and dark mode switch the page and persist across reloads', async ({ page }) => {
  await mount(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const darkBackground = await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor);
  const scrollbars = () => page.locator('#diff').evaluate(node => ({
    native: getComputedStyle(node).scrollbarColor,
    thumb: getComputedStyle(node, '::-webkit-scrollbar-thumb').backgroundColor,
    track: getComputedStyle(node, '::-webkit-scrollbar-track').backgroundColor,
    corner: getComputedStyle(node, '::-webkit-scrollbar-corner').backgroundColor,
  }));
  const darkScrollbars = await scrollbars();
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(darkBackground);
  const lightScrollbars = await scrollbars();
  for (const part of Object.keys(darkScrollbars)) expect(lightScrollbars[part]).not.toBe(darkScrollbars[part]);
  await expect.poll(() => page.evaluate(() => window.localState.theme)).toBe('light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor)).toBe(darkBackground);
  expect(await scrollbars()).toEqual(darkScrollbars);
});

test('Expand all reveals every gap while anchoring the last existing chunk', async ({ page }) => {
  const data = structuredClone(seed);
  const second = { ...structuredClone(file.hunks[0]), oldStart: 118, newStart: 119 };
  second.lines = second.lines.map(line => ({ ...line, oldLine: line.oldLine ? line.oldLine + 100 : undefined, newLine: line.newLine ? line.newLine + 101 : undefined }));
  data.files[0] = { ...file, totalOldLines: 180, hunks: [file.hunks[0], second], gaps: [
    file.gaps[0], { id: '21:22:97', before: 1, oldStart: 21, newStart: 22, count: 97 }, { id: '121:123:60', before: 2, oldStart: 121, newStart: 123, count: 60 },
  ] };
  await mount(page, data);
  const card = page.locator('.file-card').first();
  const button = card.getByRole('button', { name: 'Expand all context' });
  await button.scrollIntoViewIfNeeded();
  const lastRow = card.locator('[data-row]').last();
  const rowId = await lastRow.getAttribute('data-row');
  const before = await lastRow.boundingBox();
  await button.click();
  await expect(card.locator('.context-gap')).toHaveCount(0);
  await expect(button).toHaveCount(0);
  await expect(card.locator('.old-number').last()).toHaveText('180');
  const after = await card.locator('[data-row]').evaluateAll((rows, id) => rows.find(row => row.dataset.row === id).getBoundingClientRect().top, rowId);
  expect(Math.abs(after - before.y)).toBeLessThanOrEqual(1);
  expect(await page.locator('#diff').evaluate(node => node.scrollTop)).toBeGreaterThan(1000);
});

test('headers stay visible and the active file follows vertical scrolling', async ({ page }, testInfo) => {
  const data = structuredClone(seed);
  data.files.push(...Array.from({ length: 4 }, (_, index) => ({ ...file, path: `extra-${index}.ts` })));
  await mount(page, data);
  await page.locator('.file-card').first().getByRole('button', { name: 'Expand all context' }).click();
  const pane = page.locator('#diff');
  await pane.evaluate(node => { node.scrollTop = 500; });
  const paneBox = await pane.boundingBox();
  const padding = await pane.evaluate(node => parseFloat(getComputedStyle(node).paddingTop));
  const firstHeader = page.locator('.file-header').first();
  await expect.poll(async () => Math.abs((await firstHeader.boundingBox()).y - paneBox.y - padding)).toBeLessThanOrEqual(1);
  await expect(page.locator('.file-link.active')).toHaveAttribute('data-path', 'src/review.ts');
  await page.locator('.file-card').nth(1).evaluate(node => {
    const pane = document.querySelector('#diff');
    pane.scrollTop += node.getBoundingClientRect().top - pane.getBoundingClientRect().top + 60;
  });
  await expect(page.locator('.file-link.active')).toHaveAttribute('data-path', 'src/components/toolbar.ts');
  await expect.poll(async () => Math.abs((await page.locator('.file-header').nth(1).boundingBox()).y - paneBox.y - padding)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('sticky-header.png') });
});

test('line numbers are text, code is centered, and the hover outline follows horizontal scrolling', async ({ page }, testInfo) => {
  const data = structuredClone(seed);
  data.files[0].hunks[0].lines[0].text = 'long line '.repeat(100);
  await mount(page, data);
  const card = page.locator('.file-card').first();
  const row = card.locator('.diff-line').nth(1);
  await expect(card.locator('button.line-number')).toHaveCount(0);
  await row.locator('.old-number').click();
  await expect(page.locator('.composer')).toHaveCount(0);
  const geometry = await row.evaluate(node => {
    const row = node.getBoundingClientRect();
    const code = node.querySelector('.line-code').getBoundingClientRect();
    const number = node.querySelector('.old-number').getBoundingClientRect();
    return { row: row.height, code: code.y + code.height / 2 - row.y - row.height / 2, number: number.y + number.height / 2 - row.y - row.height / 2 };
  });
  expect(geometry.row).toBe(22);
  expect(Math.abs(geometry.code)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.number)).toBeLessThanOrEqual(1);
  const table = card.locator('.code-table');
  await table.evaluate(node => { node.scrollLeft = 300; });
  const box = await table.boundingBox();
  const rowBox = await row.boundingBox();
  await page.mouse.move(box.x + box.width / 2, rowBox.y + rowBox.height / 2);
  const outline = await row.evaluate(node => {
    const style = getComputedStyle(node, '::before');
    return { position: style.position, border: style.borderTopColor, width: parseFloat(style.width), layer: style.zIndex };
  });
  expect(outline.position).toBe('sticky');
  expect(outline.border).not.toBe('rgba(0, 0, 0, 0)');
  expect(Math.abs(outline.width - box.width)).toBeLessThanOrEqual(1);
  expect(Number(outline.layer)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('horizontal-highlight.png') });
});

test('short diff lines have no horizontal overflow while long lines remain scrollable', async ({ page }) => {
  const data = structuredClone(seed);
  data.comments = [];
  for (const file of data.files) for (const hunk of file.hunks) for (const line of hunk.lines) line.text = 'short';
  await mount(page, data);
  for (const width of [1440, 1150, 900, 700, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.locator('.code-table').evaluateAll(tables => tables.map(table => table.scrollWidth - table.clientWidth))).toEqual([0, 0, 0]);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    window.reviewState.files[0].hunks[0].lines[0].text = 'long line '.repeat(100);
    window.postMessage({ type: 'state', state: window.reviewState }, '*');
  });
  const table = page.locator('.code-table').first();
  await expect.poll(() => table.evaluate(node => node.scrollWidth - node.clientWidth)).toBeGreaterThan(1000);
  await table.evaluate(node => { node.scrollLeft = 150; });
  expect(await table.evaluate(node => node.scrollLeft)).toBe(150);
});

test('sidebar comment bodies jump to centered inline comments and editors; inline Focus opens the panel', async ({ page }) => {
  const data = structuredClone(seed);
  data.files = Array.from({ length: 8 }, (_, index) => ({ ...file, path: `part-${index}.ts` }));
  data.comments[0].path = 'part-4.ts';
  await mount(page, data);
  const pane = page.locator('#diff');
  const card = page.locator('.comment-card');
  const inline = page.locator('.inline-comment');
  const centerOffset = locator => locator.evaluate(node => {
    const pane = document.querySelector('#diff').getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    return Math.abs(rect.y + rect.height / 2 - pane.y - pane.height / 2);
  });
  await card.locator('.comment-body').click();
  await expect.poll(() => centerOffset(inline)).toBeLessThan(2);
  await pane.evaluate(node => { node.scrollTop = 0; });
  await card.getByRole('button', { name: 'Edit comment' }).click();
  await expect(page.getByRole('textbox', { name: 'Edit comment' })).toBeFocused();
  await expect.poll(() => centerOffset(page.locator('.composer'))).toBeLessThan(2);
  await page.getByRole('button', { name: 'Cancel comment' }).click();
  await page.locator('#toggle-comments').click();
  await expect(page.locator('#comments-pane')).toBeHidden();
  await inline.locator('.inline-comment-body').click();
  await expect(page.locator('#comments-pane')).toBeHidden();
  await inline.getByRole('button', { name: 'Focus comment in panel' }).click();
  await expect(page.locator('#comments-pane')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Jump to comment' })).toBeFocused();
  expect(await page.evaluate(() => window.messages.filter(message => message.type === 'jump').length)).toBe(1);
});

test('the sidebar returns to the active editor without replacing unsaved text or selection', async ({ page }) => {
  const data = structuredClone(seed);
  data.files = Array.from({ length: 12 }, (_, index) => ({ ...file, path: `part-${index}.ts` }));
  data.comments[0].path = 'part-4.ts';
  await mount(page, data);
  const card = page.locator('.comment-card');
  const textarea = page.getByRole('textbox', { name: 'Edit comment' });
  const centered = () => page.locator('.composer').evaluate(node => {
    const pane = document.querySelector('#diff').getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return Math.abs(box.y + box.height / 2 - pane.y - pane.height / 2);
  });
  await card.getByRole('button', { name: 'Edit comment' }).click();
  await expect.poll(centered).toBeLessThan(2);
  await textarea.fill('Unsaved changes stay here.');
  await textarea.evaluate(node => { node.setSelectionRange(8, 15); });
  for (const target of [card.locator('.comment-body'), card.getByRole('button', { name: 'Edit comment' })]) {
    await page.locator('#diff').evaluate(node => { node.scrollTop = 0; });
    await target.click();
    await expect.poll(centered).toBeLessThan(2);
    await expect(textarea).toBeFocused();
    await expect(textarea).toHaveValue('Unsaved changes stay here.');
    expect(await textarea.evaluate(node => [node.selectionStart, node.selectionEnd])).toEqual([8, 15]);
    await expect(page.locator('#notice')).toBeHidden();
  }
  await textarea.press('Control+Enter');
  await expect(card).toContainText('Unsaved changes stay here.');
});

test('editing an already visible comment keeps the diff in place', async ({ page }) => {
  await mount(page);
  const pane = page.locator('#diff');
  const before = await pane.evaluate(node => node.scrollTop);
  const inlineBefore = await page.locator('.inline-comment').boundingBox();
  await page.locator('.comment-card').getByRole('button', { name: 'Edit comment' }).click();
  await expect(page.getByRole('textbox', { name: 'Edit comment' })).toBeFocused();
  expect(await pane.evaluate(node => node.scrollTop)).toBe(before);
  expect(await page.locator('.inline-comment').boundingBox()).toEqual(inlineBefore);
  const box = await page.locator('.composer').boundingBox();
  const viewport = await pane.boundingBox();
  expect(box.y).toBeGreaterThan(viewport.y);
  expect(box.y + box.height).toBeLessThan(viewport.y + viewport.height);
  await page.locator('.comment-card').getByRole('button', { name: 'Edit comment' }).click();
  expect(await pane.evaluate(node => node.scrollTop)).toBe(before);
  await expect(page.locator('#notice')).toBeHidden();
});

test('first Focus only scrolls the comments pane and hover does not cover its outline', async ({ page }, testInfo) => {
  const data = structuredClone(seed);
  data.files = [...Array.from({ length: 16 }, (_, index) => ({ ...file, path: `part-${index}.ts` })), ...data.files];
  data.comments = [...Array.from({ length: 16 }, (_, index) => ({ ...seed.comments[0], id: `other-${index}`, path: `part-${index}.ts` })), ...data.comments];
  await mount(page, data);
  const inline = page.locator('.inline-comment[data-comment="existing"]');
  await inline.scrollIntoViewIfNeeded();
  const layout = () => page.evaluate(() => ({
    y: window.scrollY, x: window.scrollX,
    toolbar: document.querySelector('.toolbar').getBoundingClientRect().toJSON(),
    workspace: document.querySelector('.workspace').getBoundingClientRect().toJSON(),
    diff: document.querySelector('#diff').scrollTop,
    tables: [...document.querySelectorAll('.code-table')].map(table => table.scrollTop),
  }));
  const before = await layout();
  await inline.getByRole('button', { name: 'Focus comment in panel' }).click();
  const target = page.locator('.comment-card[data-comment="existing"]');
  await expect(target.getByRole('button', { name: 'Jump to comment' })).toBeFocused();
  await expect.poll(() => page.locator('#comments').evaluate(node => node.scrollTop)).toBeGreaterThan(1000);
  expect(await layout()).toEqual(before);
  await target.locator('.comment-body').hover();
  const outline = await target.evaluate(node => {
    const style = getComputedStyle(node, '::after');
    return { shadow: style.boxShadow, layer: style.zIndex, events: style.pointerEvents };
  });
  expect(outline.shadow).not.toBe('none');
  expect(Number(outline.layer)).toBeGreaterThan(0);
  expect(outline.events).toBe('none');
  await page.screenshot({ path: testInfo.outputPath('comment-focus-hover.png') });
});

test('repeated comment clicks restart matching finite pulses in the sidebar and diff', async ({ page }) => {
  await mount(page);
  const button = page.locator('.comment-card').getByRole('button', { name: 'Jump to comment' });
  const animations = () => page.evaluate(() => {
    const row = document.querySelector('.diff-line.flash');
    const card = document.querySelector('.comment-card.flash');
    return row && card ? [getComputedStyle(row, '::before').animationName, getComputedStyle(card, '::after').animationName] : [];
  });
  let previous = '';
  for (let click = 0; click < 4; click++) {
    await button.click();
    await expect.poll(async () => (await animations())[0]).not.toBe(previous);
    const names = await animations();
    expect(names).toHaveLength(2);
    expect(names[0]).toBe(names[1]);
    previous = names[0];
  }
  await expect(page.locator('.flash')).toHaveCount(0);
  expect(await page.locator('.comment-card').evaluate(node => getComputedStyle(node, '::after').boxShadow)).toBe('none');
});

test('comment navigation keeps the active file tied to the viewport, including repeated clicks', async ({ page }) => {
  const data = structuredClone(seed);
  data.files = Array.from({ length: 12 }, (_, index) => ({ ...file, path: `part-${index}.ts` }));
  data.comments[0].path = 'part-4.ts';
  await mount(page, data);
  await page.evaluate(() => {
    window.fileHighlights = [];
    new MutationObserver(() => {
      const pane = document.querySelector('#diff');
      window.fileHighlights.push({ path: document.querySelector('.file-link.active')?.dataset.path, top: pane.scrollTop });
    }).observe(document.querySelector('#files'), { attributes: true, subtree: true, attributeFilter: ['class'] });
  });
  const target = page.locator('.comment-card').getByRole('button', { name: 'Jump to comment' });
  await target.click();
  await expect.poll(() => page.locator('.inline-comment').evaluate(node => {
    const box = node.getBoundingClientRect();
    const pane = document.querySelector('#diff').getBoundingClientRect();
    return Math.abs(box.top + box.height / 2 - pane.top - pane.height / 2);
  })).toBeLessThan(2);
  const visiblePath = await page.locator('#diff').evaluate(pane => [...pane.querySelectorAll('.file-card')].find(card => card.getBoundingClientRect().bottom > pane.getBoundingClientRect().top + 1).dataset.path);
  expect(visiblePath).not.toBe('part-4.ts');
  await expect(page.locator('.file-link.active')).toHaveAttribute('data-path', visiblePath);
  expect(await page.evaluate(() => window.fileHighlights.some(item => item.path === 'part-4.ts'))).toBe(false);
  const top = await page.locator('#diff').evaluate(node => node.scrollTop);
  await target.click();
  await expect(page.locator('.file-link.active')).toHaveAttribute('data-path', visiblePath);
  expect(await page.locator('#diff').evaluate(node => node.scrollTop)).toBe(top);
});

test('comments follow diff file and row order, including original and new sides', async ({ page }) => {
  const data = structuredClone(seed);
  const base = data.comments[0];
  data.comments = [
    { ...base, id: 'last-file', path: 'README.md' },
    { ...base, id: 'later', line: 20, code: file.hunks[0].lines[3].text },
    { ...base, id: 'addition' },
    { ...base, id: 'deletion', side: 'old', code: file.hunks[0].lines[1].text },
    { ...base, id: 'context-new', line: 18, code: file.hunks[0].lines[0].text },
    { ...base, id: 'context-old', line: 18, side: 'old', code: file.hunks[0].lines[0].text },
  ];
  await mount(page, data);
  const order = await page.locator('.comment-card').evaluateAll(cards => cards.map(card => card.dataset.comment));
  expect(order).toEqual(['context-old', 'context-new', 'deletion', 'addition', 'later', 'last-file']);
  expect(await page.locator('.inline-comment').evaluateAll(cards => cards.map(card => card.dataset.comment))).toEqual(order);
});

test('draft reminders reveal and pulse the open saved comment or unsaved draft in red', async ({ page }, testInfo) => {
  const data = structuredClone(seed);
  data.files = Array.from({ length: 18 }, (_, index) => ({ ...file, path: `part-${index}.ts` }));
  data.comments = data.files.map((file, index) => ({ ...seed.comments[0], id: `comment-${index}`, path: file.path }));
  await mount(page, data);
  const editing = page.locator('.comment-card[data-comment="comment-17"]');
  await editing.getByRole('button', { name: 'Edit comment' }).click();
  await page.getByRole('textbox', { name: 'Edit comment' }).fill('Still editing.');
  await page.locator('#comments').evaluate(node => { node.scrollTop = 0; });
  await page.locator('.comment-card[data-comment="comment-0"]').getByRole('button', { name: 'Jump to comment' }).click();
  await expect(page.locator('#notice')).toContainText('Save or cancel');
  await expect(editing).toHaveClass(/draft-warning/);
  await expect.poll(() => editing.evaluate(node => {
    const card = node.getBoundingClientRect();
    const pane = document.querySelector('#comments').getBoundingClientRect();
    return card.top >= pane.top - 1 && card.bottom <= pane.bottom + 1;
  })).toBe(true);
  expect(await editing.evaluate(node => getComputedStyle(node).getPropertyValue('--pulse-color').trim())).toBe(await editing.evaluate(node => getComputedStyle(node).getPropertyValue('--red').trim()));
  await page.screenshot({ path: testInfo.outputPath('draft-warning.png') });
  await page.getByRole('button', { name: 'Cancel comment' }).click();
  await page.getByRole('button', { name: 'Comment on part-17.ts:20', exact: true }).click();
  await page.getByRole('textbox', { name: 'Write a comment' }).fill('New draft.');
  await page.locator('[data-scope="staged"]').click();
  await expect(page.locator('.draft-card')).toHaveClass(/draft-warning/);
  await expect(page.locator('.draft-card')).toContainText('New draft.');
  await expect(page.locator('[data-scope="uncommitted"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.draft-card').getByRole('button', { name: 'Return to draft' }).click();
  await expect(page.getByRole('textbox', { name: 'Write a comment' })).toBeFocused();
});

test('Shift alone does not restore a pointer focus ring; Tab still shows keyboard focus', async ({ page }) => {
  await mount(page);
  const button = page.locator('.comment-card').getByRole('button', { name: 'Jump to comment' });
  await button.click();
  await expect(page.locator('.flash')).toHaveCount(0);
  await page.keyboard.press('Shift');
  expect(await button.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('none');
  expect(await page.locator('.comment-card').evaluate(node => getComputedStyle(node, '::after').borderColor)).toBe('rgba(0, 0, 0, 0)');
  await page.keyboard.press('Tab');
  const active = page.locator(':focus');
  await expect(active).toHaveAttribute('aria-label', 'Edit comment');
  expect(await active.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid');
});

test('the focus dot tracks real focus entering and leaving the review frame', async ({ page }) => {
  await mount(page);
  await page.goto('http://difff.test/host');
  const review = page.frameLocator('iframe');
  const indicator = review.locator('#focus-status');
  await page.locator('#outside').click();
  await expect(indicator).not.toHaveClass(/focused/);
  await expect(indicator).toHaveAttribute('aria-label', /not focused/);
  const grey = await indicator.evaluate(node => getComputedStyle(node).backgroundColor);
  await review.locator('.line-code').first().click();
  await expect(indicator).toHaveClass(/focused/);
  const green = await indicator.evaluate(node => getComputedStyle(node).backgroundColor);
  expect(green).not.toBe(grey);
  await page.keyboard.press('Control+f');
  await expect(review.getByRole('textbox', { name: 'Find in diff' })).toBeFocused();
  await page.locator('#outside').click();
  await expect(indicator).not.toHaveClass(/focused/);
  expect(await indicator.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(grey);
});

test('deleting comments above and below the view preserves the visible diff', async ({ page }) => {
  const data = structuredClone(seed);
  data.files = Array.from({ length: 12 }, (_, index) => ({ ...file, path: `part-${index}.ts` }));
  data.comments = [
    { ...data.comments[0], id: 'above', path: 'part-0.ts' },
    { ...data.comments[0], id: 'below', path: 'part-10.ts' },
  ];
  await mount(page, data);
  const row = page.locator('.file-card[data-path="part-5.ts"] .diff-line').first();
  await row.evaluate(node => {
    const pane = document.querySelector('#diff');
    pane.scrollTop += node.getBoundingClientRect().top - pane.getBoundingClientRect().top - 180;
  });
  const before = await row.boundingBox();
  for (const id of ['above', 'below']) {
    await page.locator(`.comment-card[data-comment="${id}"]`).getByRole('button', { name: 'Delete comment' }).click();
    await expect(page.locator(`.comment-card[data-comment="${id}"]`)).toHaveCount(0);
    const after = await row.boundingBox();
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
    expect(after.x).toBe(before.x);
    expect(after.width).toBe(before.width);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  }
});

test('drag selection uses the text end beyond the right boundary and excludes comment buttons', async ({ page }) => {
  const data = structuredClone(seed);
  const text = 'alpha beta gamma delta';
  data.files[0].hunks[0].lines[0].text = text;
  data.comments = [];
  await mount(page, data);
  const code = page.locator('.line-code').first();
  const position = await code.evaluate(node => {
    const full = document.createRange();
    full.selectNodeContents(node);
    const text = full.getBoundingClientRect();
    const prefix = document.createRange();
    prefix.setStart(node.firstChild, 0);
    prefix.setEnd(node.firstChild, 6);
    const left = prefix.getBoundingClientRect().right;
    return { inside: left + .1, outside: text.right + 90, y: text.y + text.height / 2 };
  });
  for (const [from, to] of [[position.inside, position.outside], [position.outside, position.inside]]) {
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.mouse.move(from, position.y);
    await page.mouse.down();
    await page.mouse.move(to, position.y, { steps: 12 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.getSelection().toString())).toBe(text.slice(6));
  }
  expect(await page.locator('.add-comment').first().evaluate(node => getComputedStyle(node).userSelect)).toBe('none');
});

test('clicking a partially clipped file reveals it immediately without waiting for diff scrolling', async ({ page }) => {
  const data = structuredClone(seed);
  data.files = Array.from({ length: 70 }, (_, index) => ({ ...file, path: `src/part-${index}.ts` }));
  data.comments = [];
  await mount(page, data);
  const target = page.locator('.file-link').nth(30);
  await target.evaluate(node => {
    const pane = document.querySelector('#files');
    pane.scrollTop += node.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientHeight + 12;
  });
  const box = await target.boundingBox();
  const pane = await page.locator('#files').boundingBox();
  expect(box.y + box.height).toBeGreaterThan(pane.y + pane.height);
  // Use the visible sliver so Playwright does not scroll the item for us.
  await page.mouse.click(box.x + 20, box.y + 5);
  await expect(target).toHaveAttribute('aria-current', 'true');
  const after = await target.boundingBox();
  expect(after.y).toBeGreaterThanOrEqual(pane.y);
  expect(after.y + after.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
  await expect(target).toBeFocused();
});
