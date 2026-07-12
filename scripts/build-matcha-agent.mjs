#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const matchaAgentDir = resolve(rootDir, 'matcha-agent');
const isWindows = process.platform === 'win32';
const pathEnvName = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
const bundledBunPath = resolve(
  rootDir,
  'resources',
  'bin',
  `${process.platform}-${process.arch}`,
  isWindows ? 'bun.exe' : 'bun',
);
const usesBundledBun = existsSync(bundledBunPath);
const bunCommand = usesBundledBun ? bundledBunPath : 'bun';
const bunPathPrefix = usesBundledBun ? dirname(bundledBunPath) : '';

if (process.env.SKIP_MATCHA_AGENT_BUILD === '1') {
  console.log('[build-matcha-agent] SKIP_MATCHA_AGENT_BUILD=1 set; skipping matcha-agent build.');
  process.exit(0);
}

function commandForLog(command) {
  return command === bundledBunPath ? 'bun' : command;
}

function requirePath(path, label) {
  if (!existsSync(path)) {
    console.error(`[build-matcha-agent] missing ${label}: ${path}`);
    process.exit(1);
  }
}

function run(command, args, options = {}) {
  console.log(`[build-matcha-agent] ${commandForLog(command)} ${args.join(' ')}`);
  const env = { ...process.env, ...options.env };
  if (bunPathPrefix) {
    env[pathEnvName] = `${bunPathPrefix}${delimiter}${process.env[pathEnvName] ?? ''}`;
  }

  const result = spawnSync(command, args, {
    cwd: matchaAgentDir,
    stdio: 'inherit',
    env,
  });

  if (result.error) {
    console.error(`[build-matcha-agent] failed to spawn ${command}:`, result.error);
    if (command === 'bun') {
      console.error('[build-matcha-agent] install Bun or run `pnpm run bun:download` first.');
    }
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

requirePath(resolve(matchaAgentDir, 'package.json'), 'matcha-agent/package.json');
requirePath(resolve(matchaAgentDir, 'bun.lock'), 'matcha-agent/bun.lock');

run(bunCommand, ['install', '--frozen-lockfile'], {
  env: {
    CLAUDE_CODE_SKIP_CHROME_MCP_SETUP: '1',
    HUSKY: '0',
  },
});
run(bunCommand, ['run', 'build:vite']);

requirePath(resolve(matchaAgentDir, 'dist', 'cli-node.js'), 'matcha-agent/dist/cli-node.js');
requirePath(resolve(matchaAgentDir, 'dist', 'cli-bun.js'), 'matcha-agent/dist/cli-bun.js');
requirePath(resolve(matchaAgentDir, 'dist', 'cli.js'), 'matcha-agent/dist/cli.js');

console.log('[build-matcha-agent] built matcha-agent/dist');
