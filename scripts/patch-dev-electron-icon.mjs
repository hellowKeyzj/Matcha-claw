#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const iconPath = join(projectRoot, 'resources', 'icons', 'icon.ico');
const cacheRoot = join(projectRoot, '.cache', 'matchaclaw', 'dev-electron-icon');
const distPath = join(cacheRoot, 'dist');
const markerPath = join(cacheRoot, 'receipt.json');

if (process.platform !== 'win32') {
  process.exit(0);
}

delete process.env.ELECTRON_OVERRIDE_DIST_PATH;

function fail(message) {
  console.error(`[dev-electron-icon] ${message}`);
  process.exit(1);
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fileSignature(path) {
  const stat = statSync(path);
  return {
    path,
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function findRcedit() {
  const direct = join(projectRoot, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
  if (existsSync(direct)) {
    return direct;
  }

  const pnpmRoot = join(projectRoot, 'node_modules', '.pnpm');
  if (!existsSync(pnpmRoot)) {
    return null;
  }

  for (const entry of readdirSync(pnpmRoot).filter((name) => name.startsWith('electron-winstaller@')).sort()) {
    const candidate = join(pnpmRoot, entry, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function desiredReceipt(sourceElectronExe, iconHash) {
  return {
    version: 1,
    sourceElectron: fileSignature(sourceElectronExe),
    icon: {
      path: iconPath,
      sha256: iconHash,
    },
    distPath,
    electronExe: join(distPath, basename(sourceElectronExe)),
  };
}

function sameReceipt(left, right) {
  return left?.version === right.version
    && left.sourceElectron?.path === right.sourceElectron.path
    && left.sourceElectron?.size === right.sourceElectron.size
    && left.sourceElectron?.mtimeMs === right.sourceElectron.mtimeMs
    && left.icon?.path === right.icon.path
    && left.icon?.sha256 === right.icon.sha256
    && left.distPath === right.distPath
    && left.electronExe === right.electronExe;
}

const sourceElectronExe = require('electron');
if (typeof sourceElectronExe !== 'string' || !existsSync(sourceElectronExe)) {
  fail('Electron executable was not found. Run pnpm install first.');
}
if (!existsSync(iconPath)) {
  fail(`Icon file was not found: ${iconPath}`);
}

const iconHash = fileSha256(iconPath);
const next = desiredReceipt(sourceElectronExe, iconHash);
if (existsSync(next.electronExe) && sameReceipt(readJson(markerPath), next)) {
  console.log('[dev-electron-icon] current');
  process.exit(0);
}

const rcedit = findRcedit();
if (!rcedit) {
  fail('rcedit.exe was not found under node_modules. Run pnpm install first.');
}

rmSync(cacheRoot, { recursive: true, force: true });
mkdirSync(cacheRoot, { recursive: true });
cpSync(dirname(sourceElectronExe), distPath, { recursive: true });

const result = spawnSync(rcedit, [next.electronExe, '--set-icon', iconPath], {
  cwd: projectRoot,
  encoding: 'utf8',
  stdio: 'pipe',
});
if (result.status !== 0) {
  const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
  fail(`Failed to patch Electron dev icon.${detail ? `\n${detail}` : ''}`);
}

writeFileSync(markerPath, `${JSON.stringify(next, null, 2)}\n`);
console.log('[dev-electron-icon] patched');
