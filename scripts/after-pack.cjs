/**
 * after-pack.cjs
 *
 * electron-builder afterPack hook.
 *
 * Problem: electron-builder respects .gitignore when copying extraResources.
 * Since .gitignore contains "node_modules/", the openclaw bundle's
 * node_modules directory is silently skipped during the extraResources copy.
 *
 * Solution: This hook runs AFTER electron-builder finishes packing. It manually
 * copies build/openclaw/node_modules/ into the output resources directory,
 * bypassing electron-builder's glob filtering entirely.
 *
 * Additionally it performs two rounds of cleanup:
 *   1. General cleanup — removes dev artifacts (type defs, source maps,
 *      test dirs) from both the openclaw root and its node_modules.
 *   2. Platform-specific cleanup — filters known package-owned native layouts
 *      in copied dependencies (including nested deps/extensions) and vendors.
 * The named beforePack hook selects main-app node-pty variants before ASAR.
 */

const { cpSync, existsSync, readdirSync, rmSync, mkdirSync, realpathSync, readFileSync, writeFileSync } = require('fs');
const { join, dirname, basename } = require('path');
const { safeRmSync } = require('./lib/safe-delete.mjs');
const {
  targetArchitectures, matchesTarget,
  cleanupOnnxRuntimeBinaries, cleanupNativeDependencyTree, isNonTargetNativePackage,
} = require('./lib/native-platform.cjs');
const STRIP_LINKER_ARTIFACTS = process.env.MATCHACLAW_STRIP_LINKER_ARTIFACTS === '1';

// On Windows, paths in pnpm's virtual store can exceed the default MAX_PATH
// limit (260 chars). Node.js 18.17+ respects the system LongPathsEnabled
// registry key, but as a safety net we normalize paths to use the \\?\ prefix
// on Windows, which bypasses the limit unconditionally.
function normWin(p) {
  if (process.platform !== 'win32') return p;
  if (p.startsWith('\\\\?\\')) return p;
  return '\\\\?\\' + p.replace(/\//g, '\\');
}

function realpathSafe(p) {
  const normalized = normWin(p);
  try {
    return realpathSync(normalized);
  } catch (error) {
    if (process.platform === 'win32' && normalized !== p) {
      return realpathSync(p);
    }
    throw error;
  }
}

// ── Arch helpers ─────────────────────────────────────────────────────────────
// electron-builder Arch enum: 0=ia32, 1=x64, 2=armv7l, 3=arm64, 4=universal
const ARCH_MAP = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

function resolveArch(archEnum) {
  const arch = ARCH_MAP[archEnum];
  if (!arch) throw new Error(`Unsupported packaging architecture: ${archEnum}`);
  return arch;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(normWin(filePath), 'utf8'));
  } catch {
    return null;
  }
}

function listPackageDeps(pkgJson) {
  return Object.keys({
    ...(pkgJson?.dependencies && typeof pkgJson.dependencies === 'object' ? pkgJson.dependencies : {}),
    ...(pkgJson?.optionalDependencies && typeof pkgJson.optionalDependencies === 'object' ? pkgJson.optionalDependencies : {}),
  }).sort((a, b) => a.localeCompare(b));
}

function readInstalledPackageVersion(packageDir) {
  const pkg = readJsonSafe(join(packageDir, 'package.json'));
  return typeof pkg?.version === 'string' ? pkg.version.trim() : null;
}

// ── General cleanup ──────────────────────────────────────────────────────────

function cleanupUnnecessaryFiles(dir) {
  let removedCount = 0;

  const REMOVE_DIRS = new Set([
    'test', 'tests', '__tests__', '.github', 'examples', 'example',
  ]);
  const REMOVE_FILE_EXTS = [
    '.d.ts', '.d.ts.map',
    '.d.mts', '.d.mts.map',
    '.d.cts', '.d.cts.map',
    '.js.map', '.mjs.map', '.ts.map', '.map',
    // 调试符号文件，删除不影响运行。
    '.pdb', '.ipdb', '.iobj',
    // 链接中间产物默认不删；仅在显式开启激进瘦身时删除。
    ...(STRIP_LINKER_ARTIFACTS ? ['.lib', '.exp', '.ilk', '.obj', '.o'] : []),
  ];
  const REMOVE_FILE_NAMES = new Set([
    '.DS_Store',
    'tsconfig.json', '.npmignore', '.eslintrc', '.prettierrc', '.editorconfig',
  ]);

  function walk(currentDir) {
    let entries;
    try { entries = readdirSync(currentDir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (REMOVE_DIRS.has(entry.name)) {
          try { if (safeRmSync(fullPath, { root: dir })) removedCount++; } catch { /* */ }
        } else {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        const name = entry.name;
        if (REMOVE_FILE_NAMES.has(name) || REMOVE_FILE_EXTS.some(e => name.endsWith(e))) {
          try { rmSync(fullPath, { force: true }); removedCount++; } catch { /* */ }
        }
      }
    }
  }

  walk(dir);
  return removedCount;
}

// ── Broken module patcher ─────────────────────────────────────────────────────
// Some bundled packages have transpiled CJS that sets `module.exports = exports.default`
// without ever assigning `exports.default`, leaving module.exports === undefined.
// This causes `TypeError: Cannot convert undefined or null to object` in Node.js 22+
// ESM interop (translators.js hasOwnProperty call).  We patch these after copying.

const MODULE_PATCHES = {
  // node-domexception@1.0.0: index.js sets module.exports = undefined.
  // Node.js 18+ ships DOMException as a built-in; this shim re-exports it.
  'node-domexception/index.js': [
    "'use strict';",
    '// Shim: original transpiled file sets module.exports = exports.default (undefined).',
    '// Node.js 18+ has DOMException as a built-in global.',
    'const dom = globalThis.DOMException ||',
    '  class DOMException extends Error {',
    "    constructor(msg, name) { super(msg); this.name = name || 'Error'; }",
    '  };',
    'module.exports = dom;',
    'module.exports.DOMException = dom;',
    'module.exports.default = dom;',
  ].join('\n') + '\n',
};

function patchBrokenModules(nodeModulesDir) {
  const { readFileSync, writeFileSync } = require('fs');
  let count = 0;
  for (const [rel, content] of Object.entries(MODULE_PATCHES)) {
    const target = join(nodeModulesDir, rel);
    if (existsSync(target)) {
      writeFileSync(target, content, 'utf8');
      count++;
    }
  }

  // https-proxy-agent@8.x 仅声明了 ESM 导出，OpenClaw 网关在部分路径下通过
  // require() 加载会触发 ERR_PACKAGE_PATH_NOT_EXPORTED。这里补上 require 分支，
  // 保证打包后运行时兼容 CJS 调用链。
  const hpaPkgPath = join(nodeModulesDir, 'https-proxy-agent', 'package.json');
  if (existsSync(hpaPkgPath)) {
    try {
      const raw = readFileSync(hpaPkgPath, 'utf8');
      const pkg = JSON.parse(raw);
      const exp = pkg.exports;
      if (exp && exp.import && !exp.require && !exp['.']) {
        pkg.exports = {
          '.': {
            import: exp.import,
            require: exp.import,
            default: typeof exp.import === 'string' ? exp.import : exp.import.default,
          },
        };
        writeFileSync(hpaPkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
        count++;
        console.log('[after-pack] 🩹 Patched https-proxy-agent exports for CJS compatibility');
      }
    } catch (error) {
      console.warn(`[after-pack] ⚠️  Failed to patch https-proxy-agent: ${error.message}`);
    }
  }

  if (count > 0) {
    console.log(`[after-pack] 🩹 Patched ${count} broken module(s) in ${nodeModulesDir}`);
  }
}

// ── Plugin ID mismatch patcher ───────────────────────────────────────────────
// 某些插件（已知 wecom/qqbot）在编译产物里硬编码了旧 id，导致和
// openclaw.plugin.json 声明不一致，网关会拒绝加载。
const PLUGIN_ID_FIXES = {
  'wecom-openclaw-plugin': 'wecom',
};

function patchPluginIds(pluginDir, expectedId) {
  const { readFileSync, writeFileSync } = require('fs');
  const pkgJsonPath = join(pluginDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return;

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    return;
  }

  const entryFiles = [pkg.main, pkg.module].filter(Boolean);
  for (const entry of entryFiles) {
    const entryPath = join(pluginDir, entry);
    if (!existsSync(entryPath)) continue;

    let content;
    try {
      content = readFileSync(entryPath, 'utf8');
    } catch {
      continue;
    }
    let patched = false;

    for (const [wrongId, correctId] of Object.entries(PLUGIN_ID_FIXES)) {
      if (correctId !== expectedId) continue;
      const pattern = new RegExp(`(\\bid\\s*:\\s*)(["'])${wrongId.replace(/-/g, '\\-')}\\2`, 'g');
      const replaced = content.replace(pattern, `$1$2${correctId}$2`);
      if (replaced !== content) {
        content = replaced;
        patched = true;
        console.log(`[after-pack] 🩹 Patching plugin ID in ${entry}: "${wrongId}" → "${correctId}"`);
      }
    }

    if (patched) {
      writeFileSync(entryPath, content, 'utf8');
    }
  }
}

// ── Plugin bundler ───────────────────────────────────────────────────────────
// Bundles a single OpenClaw plugin (and its transitive deps) from node_modules
// directly into the packaged resources directory.

function getVirtualStoreNodeModules(realPkgPath) {
  let dir = realPkgPath;
  while (dir !== dirname(dir)) {
    if (basename(dir) === 'node_modules') return dir;
    dir = dirname(dir);
  }
  return null;
}

function listPkgs(nodeModulesDir) {
  const result = [];
  const nDir = normWin(nodeModulesDir);
  if (!existsSync(nDir)) return result;
  for (const entry of readdirSync(nDir)) {
    if (entry === '.bin') continue;
    // Use original (non-normWin) join for the logical path stored in result.fullPath,
    // so callers can still call getVirtualStoreNodeModules() on it correctly.
    const fullPath = join(nodeModulesDir, entry);
    if (entry.startsWith('@')) {
      let subs;
      try { subs = readdirSync(normWin(fullPath)); } catch { continue; }
      for (const sub of subs) {
        result.push({ name: `${entry}/${sub}`, fullPath: join(fullPath, sub) });
      }
    } else {
      result.push({ name: entry, fullPath });
    }
  }
  return result;
}

function bundlePlugin(nodeModulesRoot, npmName, destDir) {
  const pkgPath = join(nodeModulesRoot, ...npmName.split('/'));
  if (!existsSync(pkgPath)) {
    console.warn(`[after-pack] ⚠️  Plugin package not found: ${pkgPath}. Run pnpm install.`);
    return false;
  }

  let realPluginPath;
  try { realPluginPath = realpathSafe(pkgPath); } catch { realPluginPath = pkgPath; }

  // Copy plugin package itself
  safeRmSync(destDir, { root: dirname(destDir) });
  mkdirSync(normWin(destDir), { recursive: true });
  cpSync(normWin(realPluginPath), normWin(destDir), { recursive: true, dereference: true });

  // Collect transitive deps via pnpm virtual store BFS
  const collected = new Map();
  const queue = [];

  const rootVirtualNM = getVirtualStoreNodeModules(realPluginPath);
  if (!rootVirtualNM) {
    console.warn(`[after-pack] ⚠️  Could not find virtual store for ${npmName}, skipping deps.`);
    return true;
  }
  queue.push({ nodeModulesDir: rootVirtualNM, skipPkg: npmName });

  // Read peerDependencies from the plugin's package.json so we don't bundle
  // packages that are provided by the host environment (e.g. openclaw itself).
  const SKIP_PACKAGES = new Set(['typescript', '@playwright/test']);
  const SKIP_SCOPES = ['@types/'];
  try {
    const pluginPkg = JSON.parse(
      require('fs').readFileSync(join(destDir, 'package.json'), 'utf8')
    );
    for (const peer of Object.keys(pluginPkg.peerDependencies || {})) {
      SKIP_PACKAGES.add(peer);
    }
  } catch { /* ignore */ }

  while (queue.length > 0) {
    const { nodeModulesDir, skipPkg } = queue.shift();
    for (const { name, fullPath } of listPkgs(nodeModulesDir)) {
      if (name === skipPkg) continue;
      if (SKIP_PACKAGES.has(name) || SKIP_SCOPES.some(s => name.startsWith(s))) continue;
      let rp;
      try { rp = realpathSafe(fullPath); } catch { continue; }
      if (collected.has(rp)) continue;
      collected.set(rp, name);
      const depVirtualNM = getVirtualStoreNodeModules(rp);
      if (depVirtualNM && depVirtualNM !== nodeModulesDir) {
        queue.push({ nodeModulesDir: depVirtualNM, skipPkg: name });
      }
    }
  }

  // Copy flattened deps into destDir/node_modules
  const destNM = join(destDir, 'node_modules');
  mkdirSync(destNM, { recursive: true });
  const copiedNames = new Set();
  let count = 0;
  for (const [rp, pkgName] of collected) {
    if (copiedNames.has(pkgName)) continue;
    copiedNames.add(pkgName);
    const d = join(destNM, pkgName);
    try {
      mkdirSync(normWin(dirname(d)), { recursive: true });
      cpSync(normWin(rp), normWin(d), { recursive: true, dereference: true });
      count++;
    } catch (e) {
      console.warn(`[after-pack]   Skipped dep ${pkgName}: ${e.message}`);
    }
  }
  console.log(`[after-pack] ✅ Plugin ${npmName}: copied ${count} deps to ${destDir}`);
  return true;
}

function copyPluginFromLocalCandidates(pluginId, candidates, destDir) {
  const sourceDir = candidates.find((dir) => existsSync(join(dir, 'openclaw.plugin.json')));
  if (!sourceDir) {
    console.warn(`[after-pack] ⚠️  Local plugin mirror not found: ${pluginId}. Checked: ${candidates.join(' | ')}`);
    return false;
  }

  safeRmSync(destDir, { root: dirname(destDir) });
  mkdirSync(normWin(destDir), { recursive: true });
  cpSync(normWin(sourceDir), normWin(destDir), { recursive: true, dereference: true });
  console.log(`[after-pack] ✅ Plugin ${pluginId}: copied local mirror from ${sourceDir}`);
  return true;
}

function cleanupMatchaAgentVendor(vendorDir, platform, arch) {
  for (const [name, binary] of [
    ['audio-capture', 'audio-capture.node'],
    ['ripgrep', platform === 'win32' ? 'rg.exe' : 'rg'],
  ]) {
    const dir = join(vendorDir, name);
    for (const targetArch of targetArchitectures(arch)) {
      const target = join(dir, `${targetArch}-${platform}`, binary);
      if (!existsSync(target)) throw new Error(`Missing target MatchaAgent asset: ${target}`);
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const [pkgArch, pkgPlatform] = entry.name.split('-');
      if (!['x64', 'arm64'].includes(pkgArch) || !['win32', 'darwin', 'linux'].includes(pkgPlatform)) continue;
      if (!matchesTarget(platform, arch, pkgPlatform, pkgArch)) {
        safeRmSync(join(dir, entry.name), { root: dir });
      }
    }
  }
}

// FileMatcher exclusions run before AsarPackager, including asarUnpack selection.
// Keep the same hook owner; do not prune shared source node_modules for one target.
const nativePackageExclusions = new WeakMap();
exports.beforePack = async function beforePack(context) {
  const platform = context.electronPlatformName;
  const arch = resolveArch(context.arch);
  const info = context.packager.info;
  const pty = join(info.appDir, 'node_modules', '@lydell', 'node-pty', 'package.json');
  const ptyRequire = require('module').createRequire(pty);
  for (const targetArch of targetArchitectures(arch)) {
    const target = ptyRequire.resolve(`@lydell/node-pty-${platform}-${targetArch}`);
    if (!existsSync(target)) throw new Error(`Missing target node-pty asset: ${target}`);
  }
  const builderRequire = require('module').createRequire(require.resolve('electron-builder/package.json'));
  const { getCollectorByPackageManager } = builderRequire('app-builder-lib/out/node-module-collector');
  const { nodeModules } = await getCollectorByPackageManager(
    await info.getPackageManager(), info.appDir, info.tempDirManager,
  ).getNodeModules({ packageName: info.metadata.name });
  const exclusions = new Set();
  const pending = [...nodeModules];
  while (pending.length > 0) {
    const dependency = pending.pop();
    if (isNonTargetNativePackage(dependency.name, platform, arch)) {
      exclusions.add(`!**/node_modules/${dependency.name}{,/**/*}`);
    }
    if (dependency.dependencies) pending.push(...dependency.dependencies);
  }
  // Extend the existing root whitelist; a separate exclusion-only set includes **/*.
  const files = context.packager.config.files.find(fileSet => fileSet.from == null && fileSet.to == null);
  // A packager can run x64 then arm64 with this same file set.
  const previousExclusions = nativePackageExclusions.get(files) || new Set();
  files.filter = files.filter.filter(pattern => !previousExclusions.has(pattern)).concat([...exclusions]);
  nativePackageExclusions.set(files, exclusions);
};

// ── Main hook ────────────────────────────────────────────────────────────────

exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const platform = context.electronPlatformName; // 'win32' | 'darwin' | 'linux'
  const arch = resolveArch(context.arch);

  console.log(`[after-pack] Target: ${platform}/${arch}`);

  const src = join(__dirname, '..', 'build', 'openclaw', 'node_modules');

  let resourcesDir;
  if (platform === 'darwin') {
    const appName = context.packager.appInfo.productFilename;
    resourcesDir = join(appOutDir, `${appName}.app`, 'Contents', 'Resources');
  } else {
    resourcesDir = join(appOutDir, 'resources');
  }

  const { checkWikiAssets } = await import('./download-wiki-assets.mjs');
  const wikiDir = join(resourcesDir, 'resources', 'wiki');
  checkWikiAssets(wikiDir, platform, arch);
  const wikiRemoved = cleanupOnnxRuntimeBinaries(join(wikiDir, 'onnxruntime'), platform, arch);
  checkWikiAssets(wikiDir, platform, arch);
  console.log(`[after-pack] Wiki assets verified; removed ${wikiRemoved} non-target ONNX Runtime directories.`);

  const openclawRoot = join(resourcesDir, 'openclaw');
  const dest = join(openclawRoot, 'node_modules');
  const nodeModulesRoot = join(__dirname, '..', 'node_modules');
  const pluginsDestRoot = join(resourcesDir, 'openclaw-plugins');

  const { isNativeExecutable } = await import('../electron/main/runtime-host-delivery/native-artifact.mjs');
  const matchaAgentDist = join(__dirname, '..', 'matcha-agent', 'dist');
  const matchaAgentDest = join(resourcesDir, 'matcha-agent', 'dist');
  for (const entry of ['cli.js', 'cli-bun.js', 'cli-node.js']) {
    if (!require('fs').statSync(join(matchaAgentDist, entry)).isFile()) {
      throw new Error(`Missing Matcha CLI artifact: ${entry}`);
    }
  }
  for (const targetArch of targetArchitectures(arch)) {
    const targetBin = join(resourcesDir, 'bin', `${platform}-${targetArch}`);
    const extension = platform === 'win32' ? '.exe' : '';
    for (const executable of [
      join(targetBin, `matcha-app-server${extension}`),
      join(targetBin, `runtime-host${extension}`),
      join(resourcesDir, 'bin', `bun${extension}`),
      ...(platform === 'win32'
        ? [join(resourcesDir, 'bin', 'git-for-windows', 'bin', 'bash.exe')]
        : [join(targetBin, 'runtime-host-guardian')]),
      join(matchaAgentDist, 'vendor', 'ripgrep', `${targetArch}-${platform}`, `rg${extension}`),
    ]) {
      if (!isNativeExecutable(executable, platform, targetArch)) {
        throw new Error(`Invalid ${platform}-${targetArch} executable artifact: ${executable}`);
      }
    }
  }
  rmSync(matchaAgentDest, { recursive: true, force: true });
  mkdirSync(dirname(matchaAgentDest), { recursive: true });
  cpSync(matchaAgentDist, matchaAgentDest, { recursive: true });
  cleanupMatchaAgentVendor(join(matchaAgentDest, 'vendor'), platform, arch);
  console.log('[after-pack] Matcha native Server and CLI execution assets verified and copied.');

  if (!existsSync(src)) {
    console.warn('[after-pack] ⚠️  build/openclaw/node_modules not found. Run bundle-openclaw first.');
    return;
  }

  // 1. Copy node_modules (electron-builder skips it due to .gitignore)
  const depCount = readdirSync(src, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== '.bin')
    .length;

  console.log(`[after-pack] Copying ${depCount} openclaw dependencies to ${dest} ...`);
  cpSync(src, dest, { recursive: true });
  console.log('[after-pack] ✅ openclaw node_modules copied.');

  // Patch broken modules whose CJS transpiled output sets module.exports = undefined,
  // causing TypeError in Node.js 22+ ESM interop.
  patchBrokenModules(dest);

  // 1.1 Bundle OpenClaw plugins into packaged resources.
  //     Third-party plugins come from node_modules; Matcha-managed local plugins
  //     come from build/openclaw-plugins, which already contains precompiled dist/.
  const BUNDLED_PLUGINS = [
    { npmName: '@soimy/dingtalk', pluginId: 'dingtalk' },
    { npmName: '@wecom/wecom-openclaw-plugin', pluginId: 'wecom' },
    { npmName: '@tencent-weixin/openclaw-weixin', pluginId: 'openclaw-weixin' },
    { npmName: '@openclaw/qqbot', pluginId: 'qqbot' },
    ...['qianfan', 'stepfun', 'tencent', 'xiaomi', 'qwen', 'kimi', 'volcengine', 'opencode'].map((pluginId) => ({
      pluginId,
      required: true,
      localSourceCandidates: [join(__dirname, '..', 'build', 'openclaw-plugins', pluginId)],
    })),
    {
      pluginId: 'task-manager',
      localSourceCandidates: [
        join(__dirname, '..', 'build', 'openclaw-plugins', 'task-manager'),
      ],
    },
    {
      pluginId: 'security-core',
      localSourceCandidates: [
        join(__dirname, '..', 'build', 'openclaw-plugins', 'security-core'),
      ],
    },
    {
      pluginId: 'browser-relay',
      localSourceCandidates: [
        join(__dirname, '..', 'build', 'openclaw-plugins', 'browser-relay'),
      ],
    },
    {
      pluginId: 'matchaclaw-media',
      localSourceCandidates: [
        join(__dirname, '..', 'build', 'openclaw-plugins', 'matchaclaw-media'),
      ],
    },
    {
      pluginId: 'openclaw-lark',
      required: true,
      localSourceCandidates: [
        join(__dirname, '..', 'build', 'openclaw-plugins', 'openclaw-lark'),
      ],
    },
  ];

  mkdirSync(pluginsDestRoot, { recursive: true });
  for (const plugin of BUNDLED_PLUGINS) {
    const { npmName, pluginId } = plugin;
    const pluginDestDir = join(pluginsDestRoot, pluginId);
    let ok = false;
    if (npmName) {
      console.log(`[after-pack] Bundling plugin ${npmName} -> ${pluginDestDir}`);
      ok = bundlePlugin(nodeModulesRoot, npmName, pluginDestDir);
    }
    if (!ok && Array.isArray(plugin.localSourceCandidates)) {
      ok = copyPluginFromLocalCandidates(pluginId, plugin.localSourceCandidates, pluginDestDir);
    }
    if (!ok && plugin.required) {
      throw new Error(`Required OpenClaw plugin ${pluginId} was not bundled into packaged resources`);
    }
    if (ok) {
      cleanupUnnecessaryFiles(pluginDestDir);
      const removed = cleanupNativeDependencyTree(join(pluginDestDir, 'node_modules'), platform, arch);
      console.log(`[after-pack] ${pluginId}: removed ${removed} non-target native variants.`);
      patchPluginIds(pluginDestDir, pluginId);
    }
  }

  // 1.2 Prepare built-in extension node_modules that electron-builder skips.
  //
  // OpenClaw ships some built-in extensions under dist/extensions/<ext>/ with
  // their own node_modules. extraResources does not reliably copy those
  // node_modules because the project .gitignore excludes node_modules. The
  // shared chunks under dist/ can also resolve packages from the top-level
  // openclaw/node_modules, so we merge missing extension deps there.
  //
  // On macOS we avoid duplicating packages already available at the top level
  // when the versions match. This reduces codesign file pressure without
  // changing runtime resolution. On Windows/Linux we keep the extension-local
  // copy to preserve the exact existing layout.
  const buildExtDir = join(__dirname, '..', 'build', 'openclaw', 'dist', 'extensions');
  const packExtDir = join(openclawRoot, 'dist', 'extensions');
  // MatchaClaw bundles the openclaw-lark plugin separately. The built-in
  // OpenClaw feishu extension is redundant and its mirrored deps make macOS
  // codesign scan far more files.
  safeRmSync(join(packExtDir, 'feishu'), { root: packExtDir });
  if (existsSync(buildExtDir)) {
    let extNMCount = 0;
    let mergedPkgCount = 0;
    let prunedSharedDepCount = 0;

    for (const extEntry of readdirSync(buildExtDir, { withFileTypes: true })) {
      if (!extEntry.isDirectory()) continue;
      if (extEntry.name === 'feishu') continue;

      const srcNM = join(buildExtDir, extEntry.name, 'node_modules');
      if (!existsSync(srcNM)) continue;

      const destExtRoot = join(packExtDir, extEntry.name);
      const destExtNM = join(destExtRoot, 'node_modules');
      safeRmSync(destExtNM, { root: destExtRoot });
      mkdirSync(destExtNM, { recursive: true });
      extNMCount++;

      if (platform === 'darwin') {
        const buildPkgPath = join(buildExtDir, extEntry.name, 'package.json');
        const packPkgPath = join(destExtRoot, 'package.json');
        const buildPkgJson = readJsonSafe(buildPkgPath) || {};
        const packPkgJson = readJsonSafe(packPkgPath) || JSON.parse(JSON.stringify(buildPkgJson));

        for (const depName of listPackageDeps(buildPkgJson)) {
          const srcDepPkg = join(srcNM, ...depName.split('/'));
          const destDepPkg = join(dest, ...depName.split('/'));
          if (!existsSync(destDepPkg) && existsSync(srcDepPkg)) {
            mkdirSync(dirname(destDepPkg), { recursive: true });
            cpSync(srcDepPkg, destDepPkg, { recursive: true });
            mergedPkgCount++;
          }

          const srcVersion = existsSync(srcDepPkg) ? readInstalledPackageVersion(srcDepPkg) : null;
          const destVersion = existsSync(destDepPkg) ? readInstalledPackageVersion(destDepPkg) : null;
          const canReuseTopLevel = existsSync(destDepPkg) && (
            !srcVersion || (destVersion && srcVersion === destVersion)
          );
          if (canReuseTopLevel) {
            if (packPkgJson.dependencies && depName in packPkgJson.dependencies) {
              delete packPkgJson.dependencies[depName];
              prunedSharedDepCount++;
            }
            if (packPkgJson.optionalDependencies && depName in packPkgJson.optionalDependencies) {
              delete packPkgJson.optionalDependencies[depName];
              prunedSharedDepCount++;
            }
            continue;
          }

          const extDepPkg = join(destExtNM, ...depName.split('/'));
          mkdirSync(dirname(extDepPkg), { recursive: true });
          if (existsSync(srcDepPkg)) {
            cpSync(srcDepPkg, extDepPkg, { recursive: true });
          } else if (existsSync(destDepPkg)) {
            cpSync(destDepPkg, extDepPkg, { recursive: true });
          }
        }

        if (packPkgJson.dependencies && Object.keys(packPkgJson.dependencies).length === 0) {
          delete packPkgJson.dependencies;
        }
        if (packPkgJson.optionalDependencies && Object.keys(packPkgJson.optionalDependencies).length === 0) {
          delete packPkgJson.optionalDependencies;
        }
        writeFileSync(packPkgPath, JSON.stringify(packPkgJson, null, 2) + '\n', 'utf8');
      } else {
        for (const pkgEntry of readdirSync(srcNM, { withFileTypes: true })) {
          if (!pkgEntry.isDirectory() || pkgEntry.name === '.bin') continue;
          const srcPkg = join(srcNM, pkgEntry.name);
          const destPkg = join(dest, pkgEntry.name);

          if (pkgEntry.name.startsWith('@')) {
            for (const scopeEntry of readdirSync(srcPkg, { withFileTypes: true })) {
              if (!scopeEntry.isDirectory()) continue;
              const srcScoped = join(srcPkg, scopeEntry.name);
              const destScoped = join(destPkg, scopeEntry.name);
              if (!existsSync(destScoped)) {
                mkdirSync(dirname(destScoped), { recursive: true });
                cpSync(srcScoped, destScoped, { recursive: true });
                mergedPkgCount++;
              }

              const extScoped = join(destExtNM, pkgEntry.name, scopeEntry.name);
              mkdirSync(dirname(extScoped), { recursive: true });
              cpSync(srcScoped, extScoped, { recursive: true });
            }
          } else {
            if (!existsSync(destPkg)) {
              cpSync(srcPkg, destPkg, { recursive: true });
              mergedPkgCount++;
            }

            const extPkg = join(destExtNM, pkgEntry.name);
            cpSync(srcPkg, extPkg, { recursive: true });
          }
        }
      }
    }

    if (extNMCount > 0) {
      console.log(`[after-pack] ✅ Prepared node_modules for ${extNMCount} built-in extension(s), merged ${mergedPkgCount} packages into top-level${prunedSharedDepCount > 0 ? `, pruned ${prunedSharedDepCount} redundant direct deps on macOS` : ''}.`);
    }
  }

  // 2. General cleanup on the full openclaw directory (not just node_modules)
  console.log('[after-pack] 🧹 Cleaning up unnecessary files ...');
  const removedRoot = cleanupUnnecessaryFiles(openclawRoot);
  console.log(`[after-pack] ✅ Removed ${removedRoot} unnecessary files/directories.`);

  const nativeRemoved = cleanupNativeDependencyTree(dest, platform, arch);
  if (existsSync(packExtDir)) {
    for (const entry of readdirSync(packExtDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        cleanupNativeDependencyTree(join(packExtDir, entry.name, 'node_modules'), platform, arch);
      }
    }
  }
  console.log(`[after-pack] Removed ${nativeRemoved} non-target top-level/nested native variants.`);

  // 5. [Windows only] Ensure NSIS templates use the overwrite-upgrade path.
  if (platform === 'win32') {
    const { patchWindowsNsisTemplates } = await import('./patch-nsis-win.mjs');
    if (!patchWindowsNsisTemplates()) {
      throw new Error('Failed to patch NSIS install templates for overwrite upgrades.');
    }
    console.log('[after-pack] ⚡ NSIS install templates ready (overwrite upgrade).');
  }
};

exports.__test__ = {
  cleanupNativePlatformPackages: require('./lib/native-platform.cjs').cleanupNativePlatformPackages,
};
