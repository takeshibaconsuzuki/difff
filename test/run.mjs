import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

// Editor-launched terminals can inherit this and start Electron as plain Node.js.
delete process.env.ELECTRON_RUN_AS_NODE;

await runTests({
  version: '1.138.0',
  extensionDevelopmentPath: fileURLToPath(new URL('../', import.meta.url)),
  extensionTestsPath: fileURLToPath(new URL('./extension.test.cjs', import.meta.url)),
  launchArgs: ['--disable-extensions'],
});
