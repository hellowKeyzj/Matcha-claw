#!/usr/bin/env zx

/**
 * bundle-openclaw-plugins.mjs
 *
 * Build a self-contained mirror of OpenClaw third-party plugins for packaging.
 * Current plugins:
 *   - @soimy/dingtalk -> build/openclaw-plugins/dingtalk
 *   - @wecom/wecom-openclaw-plugin -> build/openclaw-plugins/wecom
 *   - @tencent-weixin/openclaw-weixin -> build/openclaw-plugins/openclaw-weixin
 *   - memory-lancedb-pro -> build/openclaw-plugins/memory-lancedb-pro
 *
 * The output plugin directory contains:
 *   - plugin source files (index.ts, openclaw.plugin.json, package.json, ...)
 *   - plugin runtime node_modules/ (flattened direct + transitive deps)
 */

import 'zx/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.join(ROOT, 'build', 'openclaw-plugins');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const LOCAL_MINILM_MODEL_ONNX = path.join(
  ROOT,
  'packages',
  'memory-lancedb-pro',
  'models',
  'Xenova',
  'all-MiniLM-L6-v2',
  'onnx',
  'model.onnx',
);

// On Windows, pnpm virtual store paths can exceed MAX_PATH (260 chars).
// Adding \\?\ prefix bypasses the limit for Win32 fs calls.
// Node.js 18.17+ also handles this transparently when LongPathsEnabled=1,
// but this is an extra safety net for build machines where the registry key
// may not be set yet.
function normWin(p) {
  if (process.platform !== 'win32') return p;
  if (p.startsWith('\\\\?\\')) return p;
  return '\\\\?\\' + p.replace(/\//g, '\\');
}

function realpathSafe(p) {
  const normalized = normWin(p);
  try {
    return fs.realpathSync(normalized);
  } catch (error) {
    if (process.platform === 'win32' && normalized !== p) {
      return fs.realpathSync(p);
    }
    throw error;
  }
}

const PLUGINS = [
  { npmName: '@soimy/dingtalk', pluginId: 'dingtalk' },
  { npmName: '@wecom/wecom-openclaw-plugin', pluginId: 'wecom' },
  { npmName: '@tencent-weixin/openclaw-weixin', pluginId: 'openclaw-weixin' },
  { npmName: '@tencent-connect/openclaw-qqbot', pluginId: 'openclaw-qqbot' },
  { localPath: path.join(ROOT, 'packages', 'memory-lancedb-pro'), pluginId: 'memory-lancedb-pro' },
  { localPath: path.join(ROOT, 'packages', 'openclaw-task-manager-plugin'), pluginId: 'task-manager' },
  { localPath: path.join(ROOT, 'packages', 'openclaw-security-plugin'), pluginId: 'security-core' },
  { localPath: path.join(ROOT, 'packages', 'openclaw-browser-relay-plugin'), pluginId: 'browser-relay' },
  { npmName: '@larksuite/openclaw-lark', pluginId: 'feishu-openclaw-plugin' },
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getRuntimeDependencyNames(packageJson) {
  return Object.keys(packageJson?.dependencies ?? {});
}

function resolveInstalledPackagePath(packageName, nodeModulesDirs = [NODE_MODULES]) {
  for (const nodeModulesDir of nodeModulesDirs) {
    const packagePath = path.join(nodeModulesDir, ...packageName.split('/'));
    if (fs.existsSync(packagePath)) {
      return packagePath;
    }
  }
  return null;
}

function createSkipPackages(packageJson) {
  const skipPackages = new Set(['typescript', '@playwright/test']);
  for (const peer of Object.keys(packageJson?.peerDependencies ?? {})) {
    skipPackages.add(peer);
  }
  return skipPackages;
}

function collectTransitiveDepsFromPackageNames(packageNames, skipPackages, nodeModulesDirs = [NODE_MODULES]) {
  const collected = new Map();
  const queue = [];
  const skipScopes = ['@types/'];

  for (const packageName of packageNames) {
    if (!packageName || skipPackages.has(packageName) || skipScopes.some((scope) => packageName.startsWith(scope))) {
      continue;
    }

    const packagePath = resolveInstalledPackagePath(packageName, nodeModulesDirs);
    if (!packagePath) {
      throw new Error(`Missing dependency "${packageName}" in root node_modules.`);
    }

    const realPath = realpathSafe(packagePath);
    if (collected.has(realPath)) {
      continue;
    }

    collected.set(realPath, packageName);
    const virtualNodeModules = getVirtualStoreNodeModules(realPath);
    if (virtualNodeModules) {
      queue.push({ nodeModulesDir: virtualNodeModules, skipPkg: packageName });
    }
  }

  while (queue.length > 0) {
    const { nodeModulesDir, skipPkg } = queue.shift();
    for (const { name, fullPath } of listPackages(nodeModulesDir)) {
      if (name === skipPkg) continue;
      if (skipPackages.has(name) || skipScopes.some((scope) => name.startsWith(scope))) continue;

      let realPath;
      try {
        realPath = realpathSafe(fullPath);
      } catch {
        continue;
      }
      if (collected.has(realPath)) continue;
      collected.set(realPath, name);

      const depVirtualNM = getVirtualStoreNodeModules(realPath);
      if (depVirtualNM && depVirtualNM !== nodeModulesDir) {
        queue.push({ nodeModulesDir: depVirtualNM, skipPkg: name });
      }
    }
  }

  return collected;
}

function copyFlattenedDeps(outputDir, collected) {
  const outputNodeModules = path.join(outputDir, 'node_modules');
  fs.mkdirSync(outputNodeModules, { recursive: true });

  let copiedCount = 0;
  let skippedDupes = 0;
  const copiedNames = new Set();

  for (const [realPath, pkgName] of collected) {
    if (copiedNames.has(pkgName)) {
      skippedDupes++;
      continue;
    }
    copiedNames.add(pkgName);

    const dest = path.join(outputNodeModules, pkgName);
    try {
      fs.mkdirSync(normWin(path.dirname(dest)), { recursive: true });
      fs.cpSync(normWin(realPath), normWin(dest), { recursive: true, dereference: true });
      copiedCount++;
    } catch (err) {
      echo`   ⚠️  Skipped ${pkgName}: ${err.message}`;
    }
  }

  return { copiedCount, skippedDupes };
}

function getVirtualStoreNodeModules(realPkgPath) {
  let dir = realPkgPath;
  while (dir !== path.dirname(dir)) {
    if (path.basename(dir) === 'node_modules') return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function listPackages(nodeModulesDir) {
  const result = [];
  const nDir = normWin(nodeModulesDir);
  if (!fs.existsSync(nDir)) return result;

  for (const entry of fs.readdirSync(nDir)) {
    if (entry === '.bin') continue;
    // Use original (non-normWin) path so callers can call
    // getVirtualStoreNodeModules() on fullPath correctly.
    const entryPath = path.join(nodeModulesDir, entry);

    if (entry.startsWith('@')) {
      let scopeEntries = [];
      try {
        scopeEntries = fs.readdirSync(normWin(entryPath));
      } catch {
        continue;
      }
      for (const sub of scopeEntries) {
        result.push({
          name: `${entry}/${sub}`,
          fullPath: path.join(entryPath, sub),
        });
      }
    } else {
      result.push({ name: entry, fullPath: entryPath });
    }
  }
  return result;
}

function bundleOnePlugin({ npmName, pluginId }) {
  const pkgPath = path.join(NODE_MODULES, ...npmName.split('/'));
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`Missing dependency "${npmName}". Run pnpm install first.`);
  }

  const realPluginPath = realpathSafe(pkgPath);
  const outputDir = path.join(OUTPUT_ROOT, pluginId);

  echo`📦 Bundling plugin ${npmName} -> ${outputDir}`;

  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });

  // 1) Copy plugin package itself
  fs.cpSync(realPluginPath, outputDir, { recursive: true, dereference: true });

  // 2) Collect transitive deps from pnpm virtual store
  const collected = new Map();
  const queue = [];
  const rootVirtualNM = getVirtualStoreNodeModules(realPluginPath);
  if (!rootVirtualNM) {
    throw new Error(`Cannot resolve virtual store node_modules for ${npmName}`);
  }
  queue.push({ nodeModulesDir: rootVirtualNM, skipPkg: npmName });

  const pluginPkg = readJson(path.join(outputDir, 'package.json'));
  const SKIP_PACKAGES = createSkipPackages(pluginPkg);
  const SKIP_SCOPES = ['@types/'];

  while (queue.length > 0) {
    const { nodeModulesDir, skipPkg } = queue.shift();
    for (const { name, fullPath } of listPackages(nodeModulesDir)) {
      if (name === skipPkg) continue;
      if (SKIP_PACKAGES.has(name) || SKIP_SCOPES.some((s) => name.startsWith(s))) continue;

      let realPath;
      try {
        realPath = realpathSafe(fullPath);
      } catch {
        continue;
      }
      if (collected.has(realPath)) continue;
      collected.set(realPath, name);

      const depVirtualNM = getVirtualStoreNodeModules(realPath);
      if (depVirtualNM && depVirtualNM !== nodeModulesDir) {
        queue.push({ nodeModulesDir: depVirtualNM, skipPkg: name });
      }
    }
  }

  // 3) Copy flattened deps into plugin/node_modules
  const { copiedCount, skippedDupes } = copyFlattenedDeps(outputDir, collected);

  const manifestPath = path.join(outputDir, 'openclaw.plugin.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing openclaw.plugin.json in bundled plugin output: ${pluginId}`);
  }

  patchPluginId(outputDir, pluginId);

  echo`   ✅ ${pluginId}: copied ${copiedCount} deps (skipped dupes: ${skippedDupes})`;
}

function patchPluginId(pluginDir, expectedId) {
  const manifestPath = path.join(pluginDir, 'openclaw.plugin.json');
  if (!fs.existsSync(manifestPath)) return;

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.id !== expectedId) {
    echo`   ⚠️  Manifest ID "${manifest.id}" 与期望 "${expectedId}" 不一致，跳过 entry 修补`;
    return;
  }

  const pkgJsonPath = path.join(pluginDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const entryFiles = [pkg.main, pkg.module].filter(Boolean);

  const ID_FIXES = {
    'wecom-openclaw-plugin': 'wecom',
    qqbot: 'openclaw-qqbot',
  };

  for (const entry of entryFiles) {
    const entryPath = path.join(pluginDir, entry);
    if (!fs.existsSync(entryPath)) continue;

    let content = fs.readFileSync(entryPath, 'utf8');
    let patched = false;

    for (const [wrongId, correctId] of Object.entries(ID_FIXES)) {
      if (correctId !== expectedId) continue;
      const pattern = new RegExp(`(\\bid\\s*:\\s*)(["'])${wrongId.replace(/-/g, '\\-')}\\2`, 'g');
      const replaced = content.replace(pattern, `$1$2${correctId}$2`);
      if (replaced !== content) {
        content = replaced;
        patched = true;
        echo`   🩹 Patching plugin ID in ${entry}: "${wrongId}" → "${correctId}"`;
      }
    }

    if (patched) {
      fs.writeFileSync(entryPath, content, 'utf8');
    }
  }
}

function ensureBundledLocalMiniLmModel() {
  if (fs.existsSync(LOCAL_MINILM_MODEL_ONNX)) {
    echo`📦 Bundled MiniLM model ready: ${LOCAL_MINILM_MODEL_ONNX}`;
    return;
  }

  throw new Error(
    [
      'Bundled MiniLM model is missing for memory-lancedb-pro.',
      'Run "pnpm run download:minilm-model" before bundling plugins.',
      'If Hugging Face direct access is blocked, set HF_ENDPOINT=https://hf-mirror.com and retry.',
    ].join(' '),
  );
}

function bundleLocalPlugin({ localPath, pluginId }) {
  const sourceDir = normWin(localPath);
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Missing local plugin source "${localPath}".`);
  }

  const outputDir = path.join(OUTPUT_ROOT, pluginId);
  echo`📦 Bundling local plugin ${localPath} -> ${outputDir}`;

  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });
  fs.cpSync(sourceDir, outputDir, { recursive: true, dereference: true });

  const manifestPath = path.join(outputDir, 'openclaw.plugin.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing openclaw.plugin.json in local plugin output: ${pluginId}`);
  }
  const pluginPkg = readJson(path.join(outputDir, 'package.json'));
  const dependencyNames = getRuntimeDependencyNames(pluginPkg);
  const dependencyMap = collectTransitiveDepsFromPackageNames(
    dependencyNames,
    createSkipPackages(pluginPkg),
    [path.join(localPath, 'node_modules'), NODE_MODULES],
  );
  const { copiedCount, skippedDupes } = copyFlattenedDeps(outputDir, dependencyMap);

  echo`   ✅ ${pluginId}: copied local source + ${copiedCount} deps (skipped dupes: ${skippedDupes})`;
}

ensureBundledLocalMiniLmModel();

echo`📦 Bundling OpenClaw plugin mirrors...`;
fs.mkdirSync(OUTPUT_ROOT, { recursive: true });

for (const plugin of PLUGINS) {
  if (plugin.npmName) {
    bundleOnePlugin(plugin);
    continue;
  }
  if (plugin.localPath) {
    bundleLocalPlugin(plugin);
  }
}

echo`✅ Plugin mirrors ready: ${OUTPUT_ROOT}`;
