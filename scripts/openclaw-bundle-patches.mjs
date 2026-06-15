import fs from 'node:fs';
import path from 'node:path';

import { REMOVED_BUNDLED_CHANNEL_PLUGIN_IDS } from './openclaw-bundled-channels.mjs';

const CUSTOM_PROVIDER_API_OWNER_HINT_NEEDLE = 'const normalizedProvider = normalizeProviderId(params.provider);\n\tif (!normalizedProvider) return;';
const CUSTOM_PROVIDER_API_OWNER_HINT_PATCHED_NEEDLE = 'const normalizedProvider = normalizeProviderId(params.provider);\n\tif (!normalizedProvider || normalizedProvider.startsWith("custom-")) return;';
const CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_NEEDLE = 'function shouldDeferSyntheticProfileAuth(params) {\n\tconst providerConfig = resolveProviderConfig(params.cfg, params.provider);';
const CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_PATCHED_NEEDLE = 'function shouldDeferSyntheticProfileAuth(params) {\n\tif (normalizeProviderId(params.provider).startsWith("custom-")) return false;\n\tconst providerConfig = resolveProviderConfig(params.cfg, params.provider);';
const RUNTIME_GATEWAY_BINDINGS_NEEDLE = 'const gatewaySubagentState = resolveGlobalSingleton(Symbol.for("openclaw.plugin.gatewaySubagentRuntime"), () => ({\n\tsubagent: void 0,\n\tnodes: void 0\n}));';
const RUNTIME_GATEWAY_BINDINGS_PATCHED_NEEDLE = 'const gatewaySubagentState = resolveGlobalSingleton(Symbol.for("openclaw.plugin.gatewaySubagentRuntime"), () => ({\n\tsubagent: void 0,\n\tnodes: void 0,\n\tgateway: void 0\n}));';
const SET_GATEWAY_NODES_RUNTIME_NEEDLE = 'function setGatewayNodesRuntime(nodes) {\n\tgatewaySubagentState.nodes = nodes;\n}';
const SET_GATEWAY_NODES_RUNTIME_PATCHED_NEEDLE = 'function setGatewayNodesRuntime(nodes) {\n\tgatewaySubagentState.nodes = nodes;\n}\nfunction setGatewayRuntime(gateway) {\n\tgatewaySubagentState.gateway = gateway;\n}';
const CLEAR_GATEWAY_RUNTIME_NEEDLE = 'function clearGatewaySubagentRuntime() {\n\tgatewaySubagentState.subagent = void 0;\n\tgatewaySubagentState.nodes = void 0;\n}';
const CLEAR_GATEWAY_RUNTIME_PATCHED_NEEDLE = 'function clearGatewaySubagentRuntime() {\n\tgatewaySubagentState.subagent = void 0;\n\tgatewaySubagentState.nodes = void 0;\n\tgatewaySubagentState.gateway = void 0;\n}';
const GATEWAY_BINDINGS_EXPORT_NEEDLE = 'export { setGatewaySubagentRuntime as i, gatewaySubagentState as n, setGatewayNodesRuntime as r, clearGatewaySubagentRuntime as t };';
const GATEWAY_BINDINGS_EXPORT_PATCHED_NEEDLE = 'export { setGatewaySubagentRuntime as i, gatewaySubagentState as n, setGatewayNodesRuntime as r, clearGatewaySubagentRuntime as t, setGatewayRuntime as u };';
const LATE_BINDING_NODES_NEEDLE = 'function createLateBindingNodes(allowGatewayBinding = false) {\n\tconst unavailable = createUnavailableNodesRuntime();\n\tif (!allowGatewayBinding) return unavailable;\n\treturn new Proxy(unavailable, { get(_target, prop, _receiver) {\n\t\tconst resolved = gatewaySubagentState.nodes ?? unavailable;\n\t\treturn Reflect.get(resolved, prop, resolved);\n\t} });\n}';
const LATE_BINDING_NODES_PATCHED_NEEDLE = 'function createLateBindingNodes(allowGatewayBinding = false) {\n\tconst unavailable = createUnavailableNodesRuntime();\n\tif (!allowGatewayBinding) return unavailable;\n\treturn new Proxy(unavailable, { get(_target, prop, _receiver) {\n\t\tconst resolved = gatewaySubagentState.nodes ?? unavailable;\n\t\treturn Reflect.get(resolved, prop, resolved);\n\t} });\n}\nfunction createUnavailableGatewayRuntime() {\n\treturn {\n\t\trequest: () => {\n\t\t\tthrow new Error("Plugin gateway runtime is only available inside the Gateway.");\n\t\t}\n\t};\n}\nfunction createLateBindingGateway(allowGatewayBinding = false) {\n\tconst unavailable = createUnavailableGatewayRuntime();\n\tif (!allowGatewayBinding) return unavailable;\n\treturn new Proxy(unavailable, { get(_target, prop, _receiver) {\n\t\tconst resolved = gatewaySubagentState.gateway ?? unavailable;\n\t\treturn Reflect.get(resolved, prop, resolved);\n\t} });\n}';
const RUNTIME_OBJECT_NEEDLE = 'subagent: createLateBindingSubagent(_options.subagent, _options.allowGatewaySubagentBinding === true),\n\t\tnodes: _options.nodes ?? createLateBindingNodes(_options.allowGatewaySubagentBinding === true),\n\t\tsystem: createRuntimeSystem(),';
const RUNTIME_OBJECT_PATCHED_NEEDLE = 'subagent: createLateBindingSubagent(_options.subagent, _options.allowGatewaySubagentBinding === true),\n\t\tnodes: _options.nodes ?? createLateBindingNodes(_options.allowGatewaySubagentBinding === true),\n\t\tgateway: createLateBindingGateway(_options.allowGatewaySubagentBinding === true),\n\t\tsystem: createRuntimeSystem(),';
const SERVER_PLUGINS_GATEWAY_RUNTIME_INSERT_NEEDLE = 'function createGatewayNodesRuntime() {\n\treturn {\n\t\tasync list(params) {';
const SERVER_PLUGINS_GATEWAY_RUNTIME_INSERT_PATCHED_NEEDLE = 'function createGatewayRequestRuntime() {\n\treturn {\n\t\tasync request(params) {\n\t\t\treturn await dispatchGatewayMethodInProcess(params.method, params.params ?? {}, {\n\t\t\t\texpectFinal: params.waitForFinal === true,\n\t\t\t\ttimeoutMs: params.timeoutMs\n\t\t\t});\n\t\t}\n\t};\n}\nfunction createGatewayNodesRuntime() {\n\treturn {\n\t\tasync list(params) {';
const SERVER_PLUGINS_EXPORT_NEEDLE = 'export { loadGatewayPlugins as a, dispatchGatewayMethodInProcessRaw as i, createGatewaySubagentRuntime as n, setFallbackGatewayContextResolver as o, dispatchGatewayMethodInProcess as r, setPluginSubagentOverridePolicies as s, createGatewayNodesRuntime as t };';
const SERVER_PLUGINS_EXPORT_PATCHED_NEEDLE = 'export { loadGatewayPlugins as a, dispatchGatewayMethodInProcessRaw as i, createGatewaySubagentRuntime as n, setFallbackGatewayContextResolver as o, dispatchGatewayMethodInProcess as r, setPluginSubagentOverridePolicies as s, createGatewayNodesRuntime as t, createGatewayRequestRuntime as u };';
const SERVER_PLUGIN_BOOTSTRAP_IMPORT_NEEDLE = 'import { a as loadGatewayPlugins, n as createGatewaySubagentRuntime, s as setPluginSubagentOverridePolicies, t as createGatewayNodesRuntime } from "./server-plugins-B7V8TIyE.js";\nimport { t as primeConfiguredBindingRegistry } from "./binding-registry-C-jk6oB8.js";\nimport { i as setGatewaySubagentRuntime, r as setGatewayNodesRuntime } from "./gateway-bindings-BnMgV9Pk.js";';
const SERVER_PLUGIN_BOOTSTRAP_IMPORT_PATCHED_NEEDLE = 'import { a as loadGatewayPlugins, n as createGatewaySubagentRuntime, s as setPluginSubagentOverridePolicies, t as createGatewayNodesRuntime, u as createGatewayRequestRuntime } from "./server-plugins-B7V8TIyE.js";\nimport { t as primeConfiguredBindingRegistry } from "./binding-registry-C-jk6oB8.js";\nimport { i as setGatewaySubagentRuntime, r as setGatewayNodesRuntime, u as setGatewayRuntime } from "./gateway-bindings-BnMgV9Pk.js";';
const SERVER_PLUGIN_BOOTSTRAP_INSTALL_NEEDLE = 'function installGatewayPluginRuntimeEnvironment(cfg) {\n\tsetPluginSubagentOverridePolicies(cfg);\n\tsetGatewaySubagentRuntime(createGatewaySubagentRuntime());\n\tsetGatewayNodesRuntime(createGatewayNodesRuntime());\n}';
const SERVER_PLUGIN_BOOTSTRAP_INSTALL_PATCHED_NEEDLE = 'function installGatewayPluginRuntimeEnvironment(cfg) {\n\tsetPluginSubagentOverridePolicies(cfg);\n\tsetGatewaySubagentRuntime(createGatewaySubagentRuntime());\n\tsetGatewayNodesRuntime(createGatewayNodesRuntime());\n\tsetGatewayRuntime(createGatewayRequestRuntime());\n}';

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

function patchRuntimeGatewayBindings(openclawDir) {
  const patchId = 'runtime-gateway-bindings';
  const distDir = path.join(openclawDir, 'dist');
  if (!fs.existsSync(distDir)) {
    return { status: 'skipped', detail: 'dist not found' };
  }

  const target = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'gateway-bindings-',
    markers: [
      'const gatewaySubagentState = resolveGlobalSingleton(Symbol.for("openclaw.plugin.gatewaySubagentRuntime")',
      'function setGatewaySubagentRuntime(subagent)',
      'function setGatewayNodesRuntime(nodes)',
      'function clearGatewaySubagentRuntime()',
    ],
  });
  const before = readText(target);
  if (before.includes(GATEWAY_BINDINGS_EXPORT_PATCHED_NEEDLE)) {
    return { status: 'clean', detail: path.relative(openclawDir, target) };
  }

  let source = before;
  source = replaceOnce(source, RUNTIME_GATEWAY_BINDINGS_NEEDLE, RUNTIME_GATEWAY_BINDINGS_PATCHED_NEEDLE, patchId);
  source = replaceOnce(source, SET_GATEWAY_NODES_RUNTIME_NEEDLE, SET_GATEWAY_NODES_RUNTIME_PATCHED_NEEDLE, patchId);
  source = replaceOnce(source, CLEAR_GATEWAY_RUNTIME_NEEDLE, CLEAR_GATEWAY_RUNTIME_PATCHED_NEEDLE, patchId);
  source = replaceOnce(source, GATEWAY_BINDINGS_EXPORT_NEEDLE, GATEWAY_BINDINGS_EXPORT_PATCHED_NEEDLE, patchId);
  verifyRuntimeGatewayBindingsPatch(source, patchId);
  writeText(target, source);
  return { status: 'applied', detail: path.relative(openclawDir, target) };
}

function verifyRuntimeGatewayBindingsPatch(source, patchId) {
  if (!source.includes(RUNTIME_GATEWAY_BINDINGS_PATCHED_NEEDLE)) {
    throw new Error(`${patchId}: gateway state verification failed`);
  }
  if (!source.includes(SET_GATEWAY_NODES_RUNTIME_PATCHED_NEEDLE)) {
    throw new Error(`${patchId}: setGatewayRuntime verification failed`);
  }
  if (!source.includes(CLEAR_GATEWAY_RUNTIME_PATCHED_NEEDLE)) {
    throw new Error(`${patchId}: clear gateway verification failed`);
  }
  if (!source.includes(GATEWAY_BINDINGS_EXPORT_PATCHED_NEEDLE)) {
    throw new Error(`${patchId}: export verification failed`);
  }
}

function patchRuntimeGatewaySurface(openclawDir) {
  const patchId = 'runtime-gateway-surface';
  const target = path.join(openclawDir, 'dist', 'plugins', 'runtime', 'index.js');
  if (!fs.existsSync(target)) {
    return { status: 'skipped', detail: 'dist/plugins/runtime/index.js not found' };
  }

  const before = readText(target);
  if (before.includes('function createLateBindingGateway(allowGatewayBinding = false)')) {
    return { status: 'clean', detail: path.relative(openclawDir, target) };
  }

  let source = before;
  source = replaceOnce(source, LATE_BINDING_NODES_NEEDLE, LATE_BINDING_NODES_PATCHED_NEEDLE, patchId);
  source = replaceOnce(source, RUNTIME_OBJECT_NEEDLE, RUNTIME_OBJECT_PATCHED_NEEDLE, patchId);
  verifyRuntimeGatewaySurfacePatch(source, patchId);
  writeText(target, source);
  return { status: 'applied', detail: path.relative(openclawDir, target) };
}

function verifyRuntimeGatewaySurfacePatch(source, patchId) {
  if (!source.includes('function createLateBindingGateway(allowGatewayBinding = false)')) {
    throw new Error(`${patchId}: late binding verification failed`);
  }
  if (!source.includes('gateway: createLateBindingGateway(_options.allowGatewaySubagentBinding === true),')) {
    throw new Error(`${patchId}: runtime surface verification failed`);
  }
}

function patchGatewayRequestRuntime(openclawDir) {
  const patchId = 'gateway-request-runtime';
  const distDir = path.join(openclawDir, 'dist');
  if (!fs.existsSync(distDir)) {
    return { status: 'skipped', detail: 'dist not found' };
  }

  const target = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'server-plugins-',
    markers: [
      'async function dispatchGatewayMethodInProcess(method, params, options)',
      'function createGatewaySubagentRuntime()',
      'function createGatewayNodesRuntime()',
    ],
  });
  const before = readText(target);
  if (before.includes('function createGatewayRequestRuntime()')) {
    return { status: 'clean', detail: path.relative(openclawDir, target) };
  }

  let source = before;
  source = replaceOnce(source, SERVER_PLUGINS_GATEWAY_RUNTIME_INSERT_NEEDLE, SERVER_PLUGINS_GATEWAY_RUNTIME_INSERT_PATCHED_NEEDLE, patchId);
  source = replaceOnce(source, SERVER_PLUGINS_EXPORT_NEEDLE, SERVER_PLUGINS_EXPORT_PATCHED_NEEDLE, patchId);
  verifyGatewayRequestRuntimePatch(source, patchId);
  writeText(target, source);
  return { status: 'applied', detail: path.relative(openclawDir, target) };
}

function verifyGatewayRequestRuntimePatch(source, patchId) {
  if (!source.includes('function createGatewayRequestRuntime()')) {
    throw new Error(`${patchId}: createGatewayRequestRuntime verification failed`);
  }
  if (!source.includes('return await dispatchGatewayMethodInProcess(params.method, params.params ?? {}, {')) {
    throw new Error(`${patchId}: dispatch bridge verification failed`);
  }
  if (!source.includes(SERVER_PLUGINS_EXPORT_PATCHED_NEEDLE)) {
    throw new Error(`${patchId}: export verification failed`);
  }
}

function patchGatewayBootstrapRuntime(openclawDir) {
  const patchId = 'gateway-bootstrap-runtime';
  const distDir = path.join(openclawDir, 'dist');
  if (!fs.existsSync(distDir)) {
    return { status: 'skipped', detail: 'dist not found' };
  }

  const target = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'server-plugin-bootstrap-',
    markers: [
      'function installGatewayPluginRuntimeEnvironment(cfg)',
      'setGatewaySubagentRuntime(createGatewaySubagentRuntime());',
      'setGatewayNodesRuntime(createGatewayNodesRuntime());',
    ],
  });
  const before = readText(target);
  if (before.includes('setGatewayRuntime(createGatewayRequestRuntime());')) {
    return { status: 'clean', detail: path.relative(openclawDir, target) };
  }

  let source = before;
  source = replaceOnce(source, SERVER_PLUGIN_BOOTSTRAP_IMPORT_NEEDLE, SERVER_PLUGIN_BOOTSTRAP_IMPORT_PATCHED_NEEDLE, patchId);
  source = replaceOnce(source, SERVER_PLUGIN_BOOTSTRAP_INSTALL_NEEDLE, SERVER_PLUGIN_BOOTSTRAP_INSTALL_PATCHED_NEEDLE, patchId);
  verifyGatewayBootstrapRuntimePatch(source, patchId);
  writeText(target, source);
  return { status: 'applied', detail: path.relative(openclawDir, target) };
}

function verifyGatewayBootstrapRuntimePatch(source, patchId) {
  if (!source.includes('createGatewayRequestRuntime')) {
    throw new Error(`${patchId}: import verification failed`);
  }
  if (!source.includes('setGatewayRuntime(createGatewayRequestRuntime());')) {
    throw new Error(`${patchId}: install verification failed`);
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
  {
    id: 'runtime-gateway-bindings',
    apply: patchRuntimeGatewayBindings,
  },
  {
    id: 'runtime-gateway-surface',
    apply: patchRuntimeGatewaySurface,
  },
  {
    id: 'gateway-request-runtime',
    apply: patchGatewayRequestRuntime,
  },
  {
    id: 'gateway-bootstrap-runtime',
    apply: patchGatewayBootstrapRuntime,
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
