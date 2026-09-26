const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const { chromium, expect } = require('@playwright/test');
const manifest = require('../package.json');

exports.run = async function run() {
  const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
  assert.ok(extension, 'VS Code should discover the extension manifest');

  await vscode.commands.executeCommand('difff.openReview');

  assert.equal(extension.isActive, true);
  await vscode.commands.executeCommand('difff.openReview');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.DIFFF_TEST_CDP_PORT}`);
  try {
    const page = browser.contexts()[0].pages().find(page => page.url().includes('workbench.html'));
    assert.ok(page, 'The development host should have a workbench window');
    page.setDefaultTimeout(30000);
    const review = page.frameLocator('iframe.webview').frameLocator('#active-frame');
    const files = review.getByRole('textbox', { name: 'Filter files' });
    const find = review.getByRole('textbox', { name: 'Find in diff' });
    const quickInput = page.locator('.quick-input-widget');
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    const diff = review.getByRole('main', { name: 'Diff review' });
    await expect(diff).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
    await diff.focus();
    await page.keyboard.press(`${modifier}+p`);
    await expect(files).toBeFocused();
    await files.fill('review');
    await page.keyboard.press(`${modifier}+f`);
    await expect(find).toBeFocused();
    await page.keyboard.press(`${modifier}+p`);
    await expect(files).toBeFocused();
    expect(await files.evaluate(node => node.value.slice(node.selectionStart, node.selectionEnd))).toBe('review');
    // Allow the host to process the forwarded event that used to steal focus.
    await page.waitForTimeout(500);
    await expect(files).toBeFocused();
    await expect(quickInput).toBeHidden();

    // Shift+Ctrl/Cmd+P must still reach VS Code's command palette.
    await page.keyboard.press(`${modifier}+Shift+p`);
    await expect(quickInput).toBeVisible();
    await page.keyboard.press('Escape');

    // Keep file actions reachable when the test host starts with a narrow editor group.
    if (await review.locator('#toggle-comments').getAttribute('aria-expanded') === 'true') await review.locator('#toggle-comments').click();
    const directory = vscode.workspace.workspaceFolders[0].uri.fsPath;
    for (const scope of ['uncommitted', 'staged', 'unstaged']) {
      await review.locator(`[data-scope="${scope}"]`).click();
      await expect(diff).toHaveAttribute('aria-busy', 'false');
      await expect(review.locator('.file-card[data-path="review.txt"]')).toBeVisible();
      if (scope !== 'unstaged') {
        const deleted = review.locator('.file-card[data-path="deleted.txt"]');
        await expect(deleted).toBeVisible();
        await expect(deleted.getByRole('button', { name: 'Open file in editor' })).toHaveCount(0);
      }
      for (const filename of ['review.txt', 'conflict.txt']) {
        await review.locator(`.file-card[data-path="${filename}"]`).getByRole('button', { name: 'Open file in editor' }).click();
        await expect.poll(() => vscode.window.activeTextEditor?.document.uri.fsPath).toBe(path.join(directory, filename));
        const opened = vscode.window.activeTextEditor.document;
        assert.equal(opened.uri.scheme, 'file');
        if (filename === 'review.txt') assert.equal(opened.getText(), 'working contents\n');
        else assert.match(opened.getText(), /<<<<<<< HEAD/);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await vscode.commands.executeCommand('difff.openReview');
      }
    }

    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    const document = await vscode.workspace.openTextDocument({ content: 'Shortcut scope check' });
    await vscode.window.showTextDocument(document);
    await page.keyboard.press(`${modifier}+p`);
    await expect(quickInput).toBeVisible();
    await page.keyboard.press('Escape');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  } finally {
    await browser.close();
  }
  console.log('Passed: review lifecycle, scoped keyboard shortcuts, and opening working files in every scope in VS Code.');
};
