import fs from 'node:fs';
import path from 'node:path';

import { REMOVED_BUNDLED_CHANNEL_PLUGIN_IDS } from './openclaw-bundled-channels.mjs';

const CUSTOM_PROVIDER_API_OWNER_HINT_NEEDLE = 'const normalizedProvider = normalizeProviderId(params.provider);\n\tif (!normalizedProvider) return;';
const CUSTOM_PROVIDER_API_OWNER_HINT_PATCHED_NEEDLE = 'const normalizedProvider = normalizeProviderId(params.provider);\n\tif (!normalizedProvider || normalizedProvider.startsWith("custom-")) return;';
const CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_NEEDLE = 'function shouldDeferSyntheticProfileAuth(params) {\n\tconst providerConfig = resolveProviderConfig(params.cfg, params.provider);';
const CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_PATCHED_NEEDLE = 'function shouldDeferSyntheticProfileAuth(params) {\n\tif (normalizeProviderId(params.provider).startsWith("custom-")) return false;\n\tconst providerConfig = resolveProviderConfig(params.cfg, params.provider);';
const WEB_LOGIN_START_SCHEMA_NEEDLE = `const WebLoginStartParamsSchema = Type.Object({
\tforce: Type.Optional(Type.Boolean()),
\ttimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
\tverbose: Type.Optional(Type.Boolean()),
\taccountId: Type.Optional(Type.String())
}, { additionalProperties: false });`;
const WEB_LOGIN_START_SCHEMA_PATCHED_NEEDLE = `const WebLoginStartParamsSchema = Type.Object({
\tchannel: Type.Optional(NonEmptyString),
\tforce: Type.Optional(Type.Boolean()),
\ttimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
\tverbose: Type.Optional(Type.Boolean()),
\taccountId: Type.Optional(Type.String())
}, { additionalProperties: false });`;
const WEB_LOGIN_WAIT_SCHEMA_NEEDLE = `const WebLoginWaitParamsSchema = Type.Object({
\ttimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
\taccountId: Type.Optional(Type.String()),
\tcurrentQrDataUrl: Type.Optional(QrDataUrlSchema)
}, { additionalProperties: false });`;
const WEB_LOGIN_WAIT_SCHEMA_PATCHED_NEEDLE = `const WebLoginWaitParamsSchema = Type.Object({
\tchannel: Type.Optional(NonEmptyString),
\ttimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
\taccountId: Type.Optional(Type.String()),
\tsessionKey: Type.Optional(NonEmptyString),
\tcurrentQrDataUrl: Type.Optional(QrDataUrlSchema)
}, { additionalProperties: false });`;
const WEB_LOGIN_PROVIDER_NEEDLE = 'const resolveWebLoginProvider = () => listChannelPlugins().find((plugin) => [...plugin.gatewayMethods ?? [], ...(plugin.gatewayMethodDescriptors ?? []).map((descriptor) => descriptor.name)].some((method) => WEB_LOGIN_METHODS.has(method))) ?? null;';
const WEB_LOGIN_PROVIDER_PATCHED_NEEDLE = `const resolveWebLoginProvider = (channelId) => {
\tconst requestedChannel = typeof channelId === "string" ? channelId.trim() : "";
\tif (requestedChannel) return getChannelPlugin(requestedChannel) ?? null;
\treturn listChannelPlugins().find((plugin) => [...plugin.gatewayMethods ?? [], ...(plugin.gatewayMethodDescriptors ?? []).map((descriptor) => descriptor.name)].some((method) => WEB_LOGIN_METHODS.has(method))) ?? null;
};`;
const WEB_LOGIN_PROVIDER_LOOKUP_NEEDLE = 'const provider = resolveWebLoginProvider();';
const WEB_LOGIN_PROVIDER_LOOKUP_PATCHED_NEEDLE = 'const provider = resolveWebLoginProvider(params.channel);';
const WEB_LOGIN_WAIT_CALL_NEEDLE = 'const result = await provider.gateway.loginWithQrWait({\n\t\t\t\ttimeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : void 0,\n\t\t\t\taccountId,\n\t\t\t\tcurrentQrDataUrl: typeof params.currentQrDataUrl === "string" ? params.currentQrDataUrl : void 0\n\t\t\t});';
const WEB_LOGIN_WAIT_CALL_PATCHED_NEEDLE = 'const result = await provider.gateway.loginWithQrWait({\n\t\t\t\ttimeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : void 0,\n\t\t\t\taccountId,\n\t\t\t\tsessionKey: typeof params.sessionKey === "string" ? params.sessionKey : void 0,\n\t\t\t\tcurrentQrDataUrl: typeof params.currentQrDataUrl === "string" ? params.currentQrDataUrl : void 0\n\t\t\t});';

function printLine(message = '') {
  process.stdout.write(`${message}\n`);
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath, source) {
  fs.writeFileSync(filePath, source);
}

function listFilesByExtension(dir, extension) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(extension)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function locateSingleJavaScriptFile(distDir, patchId, options) {
  return locateSingleFile(distDir, patchId, { ...options, extension: '.js' });
}

function locateSingleFile(distDir, patchId, options) {
  const { fileNamePrefix, markers, extension } = options;
  const candidates = listFilesByExtension(distDir, extension).filter((filePath) => (
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

function replaceAll(source, needle, replacement, patchId) {
  const count = source.split(needle).length - 1;
  if (count === 0) {
    throw new Error(`${patchId}: expected at least one needle match`);
  }
  return source.split(needle).join(replacement);
}

function patchWebLoginContract(openclawDir) {
  const patchId = 'openclaw-web-login-contract';
  const distDir = path.join(openclawDir, 'dist');
  if (!fs.existsSync(distDir)) {
    return { status: 'skipped', detail: 'dist not found' };
  }

  const protocolTarget = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'protocol-',
    markers: [
      'const WebLoginStartParamsSchema = Type.Object({',
      'const WebLoginWaitParamsSchema = Type.Object({',
      'const QrDataUrlSchema = Type.String({',
    ],
  });
  const serverTarget = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'server-methods-',
    markers: [
      'const WEB_LOGIN_METHODS = new Set(["web.login.start", "web.login.wait"]);',
      'const resolveWebLoginProvider =',
      'loginWithQrStart',
      'loginWithQrWait',
    ],
  });

  let protocolSource = readText(protocolTarget);
  let serverSource = readText(serverTarget);
  const protocolPatched = protocolSource.includes(WEB_LOGIN_START_SCHEMA_PATCHED_NEEDLE)
    && protocolSource.includes(WEB_LOGIN_WAIT_SCHEMA_PATCHED_NEEDLE);
  const serverPatched = serverSource.includes(WEB_LOGIN_PROVIDER_PATCHED_NEEDLE)
    && !serverSource.includes(WEB_LOGIN_PROVIDER_LOOKUP_NEEDLE)
    && serverSource.includes(WEB_LOGIN_WAIT_CALL_PATCHED_NEEDLE);
  if (protocolPatched && serverPatched) {
    return {
      status: 'clean',
      detail: `${path.relative(openclawDir, protocolTarget)}, ${path.relative(openclawDir, serverTarget)}`,
    };
  }

  if (!protocolSource.includes(WEB_LOGIN_START_SCHEMA_PATCHED_NEEDLE)) {
    protocolSource = replaceOnce(
      protocolSource,
      WEB_LOGIN_START_SCHEMA_NEEDLE,
      WEB_LOGIN_START_SCHEMA_PATCHED_NEEDLE,
      patchId,
    );
  }
  if (!protocolSource.includes(WEB_LOGIN_WAIT_SCHEMA_PATCHED_NEEDLE)) {
    protocolSource = replaceOnce(
      protocolSource,
      WEB_LOGIN_WAIT_SCHEMA_NEEDLE,
      WEB_LOGIN_WAIT_SCHEMA_PATCHED_NEEDLE,
      patchId,
    );
  }
  if (!serverSource.includes(WEB_LOGIN_PROVIDER_PATCHED_NEEDLE)) {
    serverSource = replaceOnce(
      serverSource,
      WEB_LOGIN_PROVIDER_NEEDLE,
      WEB_LOGIN_PROVIDER_PATCHED_NEEDLE,
      patchId,
    );
  }
  if (serverSource.includes(WEB_LOGIN_PROVIDER_LOOKUP_NEEDLE)) {
    serverSource = replaceAll(
      serverSource,
      WEB_LOGIN_PROVIDER_LOOKUP_NEEDLE,
      WEB_LOGIN_PROVIDER_LOOKUP_PATCHED_NEEDLE,
      patchId,
    );
  }
  if (!serverSource.includes(WEB_LOGIN_WAIT_CALL_PATCHED_NEEDLE)) {
    serverSource = replaceOnce(
      serverSource,
      WEB_LOGIN_WAIT_CALL_NEEDLE,
      WEB_LOGIN_WAIT_CALL_PATCHED_NEEDLE,
      patchId,
    );
  }

  if (!protocolSource.includes(WEB_LOGIN_START_SCHEMA_PATCHED_NEEDLE)
    || !protocolSource.includes(WEB_LOGIN_WAIT_SCHEMA_PATCHED_NEEDLE)
    || !serverSource.includes(WEB_LOGIN_PROVIDER_PATCHED_NEEDLE)
    || serverSource.includes(WEB_LOGIN_PROVIDER_LOOKUP_NEEDLE)
    || !serverSource.includes(WEB_LOGIN_WAIT_CALL_PATCHED_NEEDLE)) {
    throw new Error(`${patchId}: verification failed`);
  }
  writeText(protocolTarget, protocolSource);
  writeText(serverTarget, serverSource);
  return {
    status: 'applied',
    detail: `${path.relative(openclawDir, protocolTarget)}, ${path.relative(openclawDir, serverTarget)}`,
  };
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
  {
    id: 'openclaw-web-login-contract',
    apply: patchWebLoginContract,
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
