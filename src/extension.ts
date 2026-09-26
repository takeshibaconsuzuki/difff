import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('difff.helloWorld', () => {
      void vscode.window.showInformationMessage('Hello from difff!');
    }),
  );
}
