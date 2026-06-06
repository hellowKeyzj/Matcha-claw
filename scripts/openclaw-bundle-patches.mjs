import fs from 'node:fs';
import path from 'node:path';

import { REMOVED_BUNDLED_CHANNEL_PLUGIN_IDS } from './openclaw-bundled-channels.mjs';

const CUSTOM_PROVIDER_API_OWNER_HINT_NEEDLE = 'const normalizedProvider = normalizeProviderId(params.provider);\n\tif (!normalizedProvider) return;';
const CUSTOM_PROVIDER_API_OWNER_HINT_PATCHED_NEEDLE = 'const normalizedProvider = normalizeProviderId(params.provider);\n\tif (!normalizedProvider || normalizedProvider.startsWith("custom-")) return;';
const CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_NEEDLE = 'function shouldDeferSyntheticProfileAuth(params) {\n\tconst providerConfig = resolveProviderConfig(params.cfg, params.provider);';
const CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_PATCHED_NEEDLE = 'function shouldDeferSyntheticProfileAuth(params) {\n\tif (normalizeProviderId(params.provider).startsWith("custom-")) return false;\n\tconst providerConfig = resolveProviderConfig(params.cfg, params.provider);';

function printLine(message = '') {
  process.stdout.write(`${message}\n`);
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath, source) {
  fs.writeFileSync(filePath, source);
}

function listJavaScriptFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function locateSingleJavaScriptFile(distDir, patchId, options) {
  const { fileNamePrefix, markers } = options;
  const candidates = listJavaScriptFiles(distDir).filter((filePath) => (
    !fileNamePrefix || path.basename(filePath).startsWith(fileNamePrefix)
  ));
  const matches = candidates.filter((filePath) => {
    const source = readText(filePath);
    return markers.every((marker) => source.includes(marker));
  });
  if (matches.length !== 1) {
    throw new Error(`${patchId}: expected exactly one target in ${distDir}, found ${matches.length}${matches.length ? `: ${matches.map((item) => path.basename(item)).join(', ')}` : ''}`);
  }
  return matches[0];
}

function replaceOnce(source, needle, replacement, patchId) {
  const count = source.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(`${patchId}: expected one needle match, found ${count}`);
  }
  return source.replace(needle, replacement);
}

function stripBundledChannelPlugins(openclawDir) {
  const extensionsDir = path.join(openclawDir, 'dist', 'extensions');
  if (!fs.existsSync(extensionsDir)) {
    return { status: 'skipped', detail: 'dist/extensions not found' };
  }

  const removed = [];
  for (const pluginId of REMOVED_BUNDLED_CHANNEL_PLUGIN_IDS) {
    const target = path.join(extensionsDir, pluginId);
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(pluginId);
  }
  return removed.length > 0
    ? { status: 'applied', detail: removed.join(', ') }
    : { status: 'clean', detail: 'already removed' };
}

function patchCustomProviderApiOwnerHint(openclawDir) {
  const patchId = 'custom-provider-skip-api-owner-hint';
  const distDir = path.join(openclawDir, 'dist');
  if (!fs.existsSync(distDir)) {
    return { status: 'skipped', detail: 'dist not found' };
  }

  const target = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'providers.runtime-',
    markers: [
      'function resolveProviderConfigApiOwnerHint(params)',
      'const api = typeof providerConfig?.api === "string" ? normalizeProviderId(providerConfig.api) : "";',
      'return api;',
    ],
  });
  const before = readText(target);
  const alreadyPatched = before.includes(CUSTOM_PROVIDER_API_OWNER_HINT_PATCHED_NEEDLE);
  if (alreadyPatched) {
    return { status: 'clean', detail: path.relative(openclawDir, target) };
  }

  const source = replaceOnce(
    before,
    CUSTOM_PROVIDER_API_OWNER_HINT_NEEDLE,
    CUSTOM_PROVIDER_API_OWNER_HINT_PATCHED_NEEDLE,
    patchId,
  );
  verifyCustomProviderApiOwnerHintPatch(source, patchId);
  writeText(target, source);
  return { status: 'applied', detail: path.relative(openclawDir, target) };
}

function verifyCustomProviderApiOwnerHintPatch(source, patchId) {
  if (!source.includes(CUSTOM_PROVIDER_API_OWNER_HINT_PATCHED_NEEDLE)) {
    throw new Error(`${patchId}: verification failed`);
  }
}

function patchCustomProviderSyntheticProfileDefer(openclawDir) {
  const patchId = 'custom-provider-skip-synthetic-profile-defer';
  const distDir = path.join(openclawDir, 'dist');
  if (!fs.existsSync(distDir)) {
    return { status: 'skipped', detail: 'dist not found' };
  }

  const target = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'model-auth-',
    markers: [
      'function shouldDeferSyntheticProfileAuth(params)',
      'shouldDeferProviderSyntheticProfileAuthWithPlugin({',
      'resolvedApiKey: params.resolvedApiKey',
    ],
  });
  const before = readText(target);
  const alreadyPatched = before.includes(CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_PATCHED_NEEDLE);
  if (alreadyPatched) {
    return { status: 'clean', detail: path.relative(openclawDir, target) };
  }

  const source = replaceOnce(
    before,
    CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_NEEDLE,
    CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_PATCHED_NEEDLE,
    patchId,
  );
  verifyCustomProviderSyntheticProfileDeferPatch(source, patchId);
  writeText(target, source);
  return { status: 'applied', detail: path.relative(openclawDir, target) };
}

function verifyCustomProviderSyntheticProfileDeferPatch(source, patchId) {
  if (!source.includes(CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_PATCHED_NEEDLE)) {
    throw new Error(`${patchId}: verification failed`);
  }
}

const OPENCLAW_PATCHES = Object.freeze([
  {
    id: 'strip-bundled-channel-plugins',
    apply: stripBundledChannelPlugins,
  },
  {
    id: 'custom-provider-skip-api-owner-hint',
    apply: patchCustomProviderApiOwnerHint,
  },
  {
    id: 'custom-provider-skip-synthetic-profile-defer',
    apply: patchCustomProviderSyntheticProfileDefer,
  },
]);

export function applyOpenClawBundlePatches(openclawDir, options = {}) {
  const { allowMissing = false, log = printLine } = options;
  if (!fs.existsSync(openclawDir)) {
    if (allowMissing) {
      log('ℹ️  openclaw 包未安装，跳过 OpenClaw bundle patches');
      return [];
    }
    throw new Error(`openclaw package not found: ${openclawDir}`);
  }

  const results = [];
  for (const patch of OPENCLAW_PATCHES) {
    const result = patch.apply(openclawDir);
    results.push({ id: patch.id, ...result });
    const icon = result.status === 'applied' ? '🧩' : result.status === 'clean' ? '✅' : 'ℹ️';
    log(`${icon} OpenClaw patch ${patch.id}: ${result.detail}`);
  }
  return results;
}
