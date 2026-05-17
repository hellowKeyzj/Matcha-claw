#!/usr/bin/env node

/**
 * 删除 dev 模式下 `node_modules/openclaw/dist/extensions/<id>`，
 * 让 dev 行为与 `scripts/bundle-openclaw.mjs` 在 production 产物里所做的清理对齐。
 *
 * 由 `package.json` 的 `postinstall` 钩子自动调用：每次 `pnpm install` 之后
 * 都会重新执行，确保即便 pnpm 重新落地了 openclaw 包，剔除清单里的 channel
 * 插件也不会再被 Gateway 加载。
 *
 * 设计要点：
 *   - 仅删除剔除清单（`scripts/openclaw-bundled-channels.mjs`）里枚举的目录；
 *   - 当 openclaw 包未安装（首次 `pnpm install` 之前）时静默跳过；
 *   - 保持幂等：重复运行不会报错。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REMOVED_BUNDLED_CHANNEL_PLUGIN_IDS } from './openclaw-bundled-channels.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OPENCLAW_EXTENSIONS_DIR = path.join(
  REPO_ROOT,
  'node_modules',
  'openclaw',
  'dist',
  'extensions',
);

function printLine(message = '') {
  process.stdout.write(`${message}\n`);
}

function stripBundledChannelPlugins() {
  if (!fs.existsSync(OPENCLAW_EXTENSIONS_DIR)) {
    return { removed: [], skipped: true };
  }

  const removed = [];
  for (const pluginId of REMOVED_BUNDLED_CHANNEL_PLUGIN_IDS) {
    const target = path.join(OPENCLAW_EXTENSIONS_DIR, pluginId);
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(pluginId);
  }
  return { removed, skipped: false };
}

const { removed, skipped } = stripBundledChannelPlugins();
if (skipped) {
  printLine('ℹ️  openclaw 包未安装，跳过 bundled channel 剔除');
} else if (removed.length === 0) {
  printLine('✅ openclaw bundled channel 剔除清单已是干净状态');
} else {
  printLine(`🧹 已从 node_modules/openclaw/dist/extensions 中删除: ${removed.join(', ')}`);
}
