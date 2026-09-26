const assert = require('node:assert/strict');
const vscode = require('vscode');
const manifest = require('../package.json');

exports.run = async function run() {
  const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
  assert.ok(extension, 'VS Code should discover the extension manifest');

  await vscode.commands.executeCommand('difff.helloWorld');

  assert.equal(extension.isActive, true);
  console.log('Passed: the contributed command activates and runs in VS Code.');
};
