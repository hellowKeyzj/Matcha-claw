import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveNsisTemplatePath(...templatePath) {
  const candidates = [];

  try {
    const electronBuilderPackage = require.resolve('electron-builder/package.json');
    candidates.push(join(
      dirname(dirname(electronBuilderPackage)),
      'app-builder-lib',
      'templates',
      'nsis',
      ...templatePath,
    ));
  } catch {
    // Fall through to filesystem candidates below.
  }

  candidates.push(join(rootDir, 'node_modules', 'app-builder-lib', 'templates', 'nsis', ...templatePath));

  const pnpmDir = join(rootDir, 'node_modules', '.pnpm');
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('app-builder-lib@')) {
        continue;
      }
      candidates.push(join(
        pnpmDir,
        entry.name,
        'node_modules',
        'app-builder-lib',
        'templates',
        'nsis',
        ...templatePath,
      ));
    }
  }

  return candidates.find((candidate) => existsSync(candidate))
    ?? join(rootDir, 'node_modules', 'app-builder-lib', 'templates', 'nsis', ...templatePath);
}
