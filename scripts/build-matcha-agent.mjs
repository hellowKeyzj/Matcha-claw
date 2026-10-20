#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isNativeExecutable } from '../electron/main/runtime-host-delivery/native-artifact.mjs';

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
const bunCommand = bundledBunPath;
const bunPathPrefix = dirname(bundledBunPath);

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
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const { values } = parseArgs({
  options: {
    arch: { type: 'string', multiple: true },
    'if-needed': { type: 'boolean' },
  },
});
const architectures = [...new Set(values.arch ?? [process.arch])].sort();
for (const arch of architectures) {
  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error(`[build-matcha-agent] unsupported architecture: ${arch}`);
  }
}
const ifNeeded = values['if-needed'];

requirePath(resolve(matchaAgentDir, 'package.json'), 'matcha-agent/package.json');
requirePath(resolve(matchaAgentDir, 'bun.lock'), 'matcha-agent/bun.lock');

requirePath(resolve(matchaAgentDir, 'node_modules', 'vite', 'bin', 'vite.js'), 'installed CLI build dependencies');
if (!isNativeExecutable(bundledBunPath, process.platform, process.arch)) {
  throw new Error('[build-matcha-agent] target-matched bundled Bun executable is required.');
}
for (const arch of architectures) {
  const target = `${arch}-${process.platform}`;
  const ripgrep = resolve(matchaAgentDir, 'src', 'utils', 'vendor', 'ripgrep', target, isWindows ? 'rg.exe' : 'rg');
  if (!isNativeExecutable(ripgrep, process.platform, arch)) {
    throw new Error(`[build-matcha-agent] target-matched ripgrep executable is required for ${target}.`);
  }
  requirePath(resolve(matchaAgentDir, 'vendor', 'audio-capture', target, 'audio-capture.node'), `audio-capture ${target}`);
}

const outputFiles = ['cli-node.js', 'cli-bun.js', 'cli.js'].map(file => resolve(matchaAgentDir, 'dist', file));
for (const arch of architectures) {
  const target = `${arch}-${process.platform}`;
  outputFiles.push(
    resolve(matchaAgentDir, 'dist', 'vendor', 'audio-capture', target, 'audio-capture.node'),
    resolve(matchaAgentDir, 'dist', 'vendor', 'ripgrep', target, isWindows ? 'rg.exe' : 'rg'),
  );
}
const receiptPath = resolve(matchaAgentDir, 'dist', '.build-inputs.sha256');
const fingerprint = buildInputFingerprint();
if (ifNeeded && existsSync(receiptPath)
  && readFileSync(receiptPath, 'utf8').trim() === fingerprint
  && runtimeArtifactsReady()) {
  console.log('[build-matcha-agent] current');
  process.exit(0);
}

run(bunCommand, ['run', 'build:vite']);
if (!runtimeArtifactsReady()) {
  throw new Error('[build-matcha-agent] built CLI runtime artifacts are missing or invalid.');
}
writeFileSync(receiptPath, `${fingerprint}\n`);
console.log('[build-matcha-agent] built matcha-agent/dist');

function runtimeArtifactsReady() {
  return outputFiles.every(file => existsSync(file) && statSync(file).isFile())
    && architectures.every(arch => isNativeExecutable(
      resolve(matchaAgentDir, 'dist', 'vendor', 'ripgrep', `${arch}-${process.platform}`, isWindows ? 'rg.exe' : 'rg'),
      process.platform, arch,
    ));
}

function buildInputFingerprint() {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([process.platform, process.arch, architectures,
    Object.keys(process.env).filter(key => key.startsWith('FEATURE_')).sort()]));
  function add(path) {
    const stat = statSync(path);
    hash.update(JSON.stringify([path, stat.size, stat.mtimeMs]));
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', '.git', 'target', '.cache'].includes(entry.name) || entry.isSymbolicLink()) continue;
      add(resolve(path, entry.name));
    }
  }
  for (const input of ['package.json', 'bun.lock', 'vite.config.ts', 'tsconfig.json', 'tsconfig.base.json',
    'src', 'scripts', 'packages', 'vendor/audio-capture']) {
    add(resolve(matchaAgentDir, input));
  }
  add(fileURLToPath(import.meta.url));
  add(bundledBunPath);
  return hash.digest('hex');
}
