import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runVSCodeCommand } from '@vscode/test-electron';

const production = process.argv.includes('--production');
const development = process.argv.includes('--dev');
const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2022',
  external: ['vscode'],
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'info',
};

if (development) {
  const context = await esbuild.context(options);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    // Finish the first build before opening VS Code, then keep rebuilding on save.
    await context.rebuild();
    await context.watch();
    console.log('Opening the Extension Development Host without the debugger.');
    console.log('Run "difff: Hello World" there. After saving, reload only that window.');
    console.log('Keep this terminal running. Close the host window or press Ctrl+C to stop.');

    const env = { ...process.env };
    // Editor-launched terminals can otherwise start Electron as plain Node.js.
    delete env.ELECTRON_RUN_AS_NODE;

    await runVSCodeCommand([
      '--new-window',
      '--disable-extensions',
      `--extensionDevelopmentPath=${fileURLToPath(new URL('./', import.meta.url))}`,
      `--user-data-dir=${fileURLToPath(new URL('./.vscode-test/dev-user-data', import.meta.url))}`,
      `--extensions-dir=${fileURLToPath(new URL('./.vscode-test/dev-extensions', import.meta.url))}`,
      ...process.argv.slice(process.argv.indexOf('--dev') + 1),
    ], {
      version: '1.138.0',
      // The test helper hides Windows processes by default; this host is interactive.
      spawn: { env, signal: controller.signal, windowsHide: false },
    });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    await context.dispose();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
} else {
  await esbuild.build(options);
}
