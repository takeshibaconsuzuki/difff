// simple-git's env() replaces the child environment, so overrides must be layered on process.env or Git loses PATH and
// HOME, which breaks clean filters, global configuration, and user attributes. simple-git strips these guarded keys from
// an ambient environment but rejects them when supplied explicitly, so drop them here to match its default behavior.
const guarded = new Set(['editor', 'pager', 'prefix', 'ssh_askpass']);

export function gitEnvironment(overrides: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toLowerCase().trim();
    if (value !== undefined && !name.startsWith('git_') && !guarded.has(name)) environment[key] = value;
  }
  return { ...environment, ...overrides };
}
