import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { runTests } from '@vscode/test-electron';

// Editor-launched terminals can inherit this and start Electron as plain Node.js.
delete process.env.ELECTRON_RUN_AS_NODE;

// Expose only the isolated test host so Playwright can exercise real VS Code shortcuts.
const portReservation = createServer();
portReservation.listen(0, '127.0.0.1');
await once(portReservation, 'listening');
const { port } = portReservation.address();
portReservation.close();
await once(portReservation, 'close');

const fixtureParent = path.resolve(tmpdir());
const directory = await mkdtemp(path.join(fixtureParent, 'difff-host-test-'));
if (path.dirname(directory) !== fixtureParent || !path.basename(directory).startsWith('difff-host-test-')) throw new Error('Unexpected test repository path');
try {
  const git = simpleGit(directory);
  await git.init();
  await git.addConfig('user.name', 'Diff Test');
  await git.addConfig('user.email', 'diff@example.test');
  await git.addConfig('core.autocrlf', 'false');
  await git.addConfig('commit.gpgsign', 'false');
  await writeFile(path.join(directory, 'review.txt'), 'committed contents\n');
  await writeFile(path.join(directory, 'deleted.txt'), 'deleted contents\n');
  await writeFile(path.join(directory, 'conflict.txt'), 'base\n');
  await git.add('.');
  await git.commit('initial');
  const branch = (await git.raw(['branch', '--show-current'])).trim();
  await git.raw(['checkout', '-b', 'incoming']);
  await writeFile(path.join(directory, 'conflict.txt'), 'incoming\n');
  await git.commit('incoming', ['-a']);
  await git.raw(['checkout', branch]);
  await writeFile(path.join(directory, 'conflict.txt'), 'current\n');
  await git.commit('current', ['-a']);
  await git.raw(['merge', 'incoming']).catch(error => { if (!error.message.includes('CONFLICT')) throw error; });
  await writeFile(path.join(directory, 'review.txt'), 'staged contents\n');
  await git.add('review.txt');
  await writeFile(path.join(directory, 'review.txt'), 'working contents\n');
  await git.rm('deleted.txt');

  await runTests({
    version: '1.138.0',
    extensionDevelopmentPath: fileURLToPath(new URL('../', import.meta.url)),
    extensionTestsPath: fileURLToPath(new URL('./extension.test.cjs', import.meta.url)),
    launchArgs: [directory, '--disable-extensions', '--skip-welcome', '--disable-workspace-trust', `--remote-debugging-port=${port}`],
    extensionTestsEnv: { DIFFF_TEST_CDP_PORT: String(port) },
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
