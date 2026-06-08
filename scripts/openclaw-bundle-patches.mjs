import fs from 'node:fs';
import path from 'node:path';

import { REMOVED_BUNDLED_CHANNEL_PLUGIN_IDS } from './openclaw-bundled-channels.mjs';

const CUSTOM_PROVIDER_API_OWNER_HINT_NEEDLE = 'const normalizedProvider = normalizeProviderId(params.provider);\n\tif (!normalizedProvider) return;';
const CUSTOM_PROVIDER_API_OWNER_HINT_PATCHED_NEEDLE = 'const normalizedProvider = normalizeProviderId(params.provider);\n\tif (!normalizedProvider || normalizedProvider.startsWith("custom-")) return;';
const CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_NEEDLE = 'function shouldDeferSyntheticProfileAuth(params) {\n\tconst providerConfig = resolveProviderConfig(params.cfg, params.provider);';
const CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_PATCHED_NEEDLE = 'function shouldDeferSyntheticProfileAuth(params) {\n\tif (normalizeProviderId(params.provider).startsWith("custom-")) return false;\n\tconst providerConfig = resolveProviderConfig(params.cfg, params.provider);';
const SUBAGENT_RUNTIME_UNAVAILABLE_NEEDLE = '\treturn {\n\t\trun: unavailable,\n\t\twaitForRun: unavailable,';
const SUBAGENT_RUNTIME_UNAVAILABLE_PATCHED_NEEDLE = '\treturn {\n\t\tspawn: unavailable,\n\t\trun: unavailable,\n\t\twaitForRun: unavailable,';
const SUBAGENT_GATEWAY_RUNTIME_NEEDLE = '\treturn {\n\t\tasync run(params) {';
const SUBAGENT_GATEWAY_RUNTIME_PATCHED_NEEDLE = '\treturn {\n\t\tasync spawn(params) {\n\t\t\tconst result = await spawnSubagentDirect({\n\t\t\t\ttask: params.task,\n\t\t\t\ttaskName: params.taskName,\n\t\t\t\tlabel: params.label,\n\t\t\t\tagentId: params.agentId,\n\t\t\t\tmodel: params.model,\n\t\t\t\tthinking: params.thinking,\n\t\t\t\trunTimeoutSeconds: params.runTimeoutSeconds,\n\t\t\t\tthread: params.thread,\n\t\t\t\tmode: params.mode,\n\t\t\t\tcleanup: params.cleanup,\n\t\t\t\tsandbox: params.sandbox,\n\t\t\t\tcontext: params.context,\n\t\t\t\tlightContext: params.lightContext,\n\t\t\t\texpectsCompletionMessage: params.expectsCompletionMessage,\n\t\t\t\tattachments: params.attachments,\n\t\t\t\tattachMountPath: params.attachMountPath,\n\t\t\t}, {\n\t\t\t\tagentSessionKey: params.requesterSessionKey,\n\t\t\t\tagentChannel: params.requesterChannel,\n\t\t\t\tagentAccountId: params.requesterAccountId,\n\t\t\t\tagentTo: params.requesterTo,\n\t\t\t\tagentThreadId: params.requesterThreadId,\n\t\t\t\tagentGroupId: params.requesterGroupId,\n\t\t\t\tagentGroupChannel: params.requesterGroupChannel,\n\t\t\t\tagentGroupSpace: params.requesterGroupSpace,\n\t\t\t\tagentMemberRoleIds: params.requesterMemberRoleIds,\n\t\t\t\trequesterAgentIdOverride: params.requesterAgentId,\n\t\t\t\tworkspaceDir: params.workspaceDir,\n\t\t\t});\n\t\t\treturn result;\n\t\t},\n\t\tasync run(params) {';
const SUBAGENT_GATEWAY_RUNTIME_IMPORT_NEEDLE = 'import { randomUUID } from "node:crypto";';
const SUBAGENT_GATEWAY_RUNTIME_IMPORT_PATCHED_NEEDLE = 'import { randomUUID } from "node:crypto";\nimport { t as spawnSubagentDirect } from "./subagent-spawn-ALADHNnO.js";';
const SUBAGENT_RUNTIME_PROXY_NEEDLE = '\t\t\treturn {\n\t\t\t\trun: (params) => withPluginRuntimePluginIdScope(pluginId, () => subagent.run(params)),';
const SUBAGENT_RUNTIME_PROXY_PATCHED_NEEDLE = '\t\t\treturn {\n\t\t\t\tspawn: (params) => withPluginRuntimePluginIdScope(pluginId, () => subagent.spawn(params)),\n\t\t\t\trun: (params) => withPluginRuntimePluginIdScope(pluginId, () => subagent.run(params)),';

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

function patchNativeSubagentRuntimeSpawn(openclawDir) {
  const patchId = 'native-subagent-runtime-spawn';
  const distDir = path.join(openclawDir, 'dist');
  if (!fs.existsSync(distDir)) {
    return { status: 'skipped', detail: 'dist not found' };
  }

  const runtimeIndex = path.join(distDir, 'plugins', 'runtime', 'index.js');
  const runtimeTypes = path.join(distDir, 'plugin-sdk', 'src', 'plugins', 'runtime', 'types.d.ts');
  const rootRuntimeTypes = locateSingleFile(distDir, patchId, {
    fileNamePrefix: 'types-',
    extension: '.d.ts',
    markers: [
      'type SubagentRunParams = {',
      'type SubagentRunResult = {',
      'type PluginRuntime = PluginRuntimeCore & {',
      'subagent: {',
    ],
  });
  const sdkIndex = path.join(distDir, 'plugin-sdk', 'src', 'plugin-sdk', 'index.d.ts');
  const gatewayRuntime = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'server-plugins-',
    markers: [
      'function createGatewaySubagentRuntime() {',
      'async run(params) {',
      'dispatchGatewayMethod("agent", {',
    ],
  });
  const runtimeProxy = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'loader-',
    markers: [
      'withPluginRuntimePluginIdScope(pluginId, () => subagent.run(params))',
      'deleteSession: (params) => withPluginRuntimePluginIdScope(pluginId, () => subagent.deleteSession(params))',
      'pluginRuntimeById.set(pluginId, runtime)',
    ],
  });
  for (const target of [runtimeIndex, runtimeTypes, rootRuntimeTypes, sdkIndex, gatewayRuntime, runtimeProxy]) {
    if (!fs.existsSync(target)) {
      return { status: 'skipped', detail: `${path.relative(openclawDir, target)} not found` };
    }
  }

  let runtimeSource = readText(runtimeIndex);
  const runtimeAlreadyPatched = runtimeSource.includes('spawn: unavailable');
  if (!runtimeAlreadyPatched) {
    runtimeSource = replaceOnce(runtimeSource, SUBAGENT_RUNTIME_UNAVAILABLE_NEEDLE, SUBAGENT_RUNTIME_UNAVAILABLE_PATCHED_NEEDLE, patchId);
    verifyNativeSubagentRuntimeUnavailablePatch(runtimeSource, patchId);
    writeText(runtimeIndex, runtimeSource);
  }

  let gatewayRuntimeSource = readText(gatewayRuntime);
  const gatewayRuntimeAlreadyPatched = gatewayRuntimeSource.includes('async spawn(params) {') && gatewayRuntimeSource.includes('spawnSubagentDirect({');
  if (!gatewayRuntimeAlreadyPatched) {
    gatewayRuntimeSource = replaceOnce(gatewayRuntimeSource, SUBAGENT_GATEWAY_RUNTIME_IMPORT_NEEDLE, SUBAGENT_GATEWAY_RUNTIME_IMPORT_PATCHED_NEEDLE, patchId);
    gatewayRuntimeSource = replaceOnce(gatewayRuntimeSource, SUBAGENT_GATEWAY_RUNTIME_NEEDLE, SUBAGENT_GATEWAY_RUNTIME_PATCHED_NEEDLE, patchId);
    verifyNativeSubagentGatewayRuntimePatch(gatewayRuntimeSource, patchId);
    writeText(gatewayRuntime, gatewayRuntimeSource);
  }

  let runtimeTypesSource = readText(runtimeTypes);
  const runtimeTypesAlreadyPatched = runtimeTypesSource.includes('export type SubagentSpawnParams = {');
  if (!runtimeTypesAlreadyPatched) {
    runtimeTypesSource = patchNativeSubagentRuntimeTypes(runtimeTypesSource, patchId);
    writeText(runtimeTypes, runtimeTypesSource);
  }

  let rootRuntimeTypesSource = readText(rootRuntimeTypes);
  const rootRuntimeTypesAlreadyPatched = rootRuntimeTypesSource.includes('type SubagentSpawnParams = {');
  if (!rootRuntimeTypesAlreadyPatched) {
    rootRuntimeTypesSource = patchNativeSubagentRootRuntimeTypes(rootRuntimeTypesSource, patchId);
    writeText(rootRuntimeTypes, rootRuntimeTypesSource);
  }

  let runtimeProxySource = readText(runtimeProxy);
  const runtimeProxyAlreadyPatched = runtimeProxySource.includes('spawn: (params) => withPluginRuntimePluginIdScope(pluginId, () => subagent.spawn(params))');
  if (!runtimeProxyAlreadyPatched) {
    runtimeProxySource = replaceOnce(runtimeProxySource, SUBAGENT_RUNTIME_PROXY_NEEDLE, SUBAGENT_RUNTIME_PROXY_PATCHED_NEEDLE, patchId);
    verifyNativeSubagentRuntimeProxyPatch(runtimeProxySource, patchId);
    writeText(runtimeProxy, runtimeProxySource);
  }

  let sdkIndexSource = readText(sdkIndex);
  if (!sdkIndexSource.includes('SubagentSpawnParams')) {
    sdkIndexSource = replaceOnce(
      sdkIndexSource,
      'export type { PluginRuntime, RuntimeLogger, SubagentRunParams, SubagentRunResult, } from "../plugins/runtime/types.js";',
      'export type { PluginRuntime, RuntimeLogger, SubagentRunParams, SubagentRunResult, SubagentSpawnParams, SubagentSpawnResult, } from "../plugins/runtime/types.js";',
      patchId,
    );
    writeText(sdkIndex, sdkIndexSource);
  }

  const changed = runtimeAlreadyPatched && gatewayRuntimeAlreadyPatched && runtimeTypesAlreadyPatched && rootRuntimeTypesAlreadyPatched && runtimeProxyAlreadyPatched
    ? 'clean'
    : 'applied';
  return { status: changed, detail: path.relative(openclawDir, runtimeIndex) };
}

function patchNativeSubagentRuntimeTypes(source, patchId) {
  const withSpawnTypes = replaceOnce(
    source,
    'export type SubagentRunResult = {\n    runId: string;\n};\n',
    'export type SubagentRunResult = {\n    runId: string;\n};\nexport type SubagentSpawnParams = {\n    task: string;\n    taskName?: string;\n    label?: string;\n    agentId?: string;\n    model?: string;\n    thinking?: string;\n    runTimeoutSeconds?: number;\n    thread?: boolean;\n    mode?: "run" | "session";\n    cleanup?: "delete" | "keep";\n    sandbox?: "inherit" | "require";\n    context?: "isolated" | "fork";\n    lightContext?: boolean;\n    expectsCompletionMessage?: boolean;\n    attachments?: Array<Record<string, unknown>>;\n    attachMountPath?: string;\n    requesterSessionKey?: string;\n    requesterAgentId?: string;\n    requesterChannel?: string;\n    requesterAccountId?: string;\n    requesterTo?: string;\n    requesterThreadId?: string | number;\n    requesterGroupId?: string | null;\n    requesterGroupChannel?: string | null;\n    requesterGroupSpace?: string | null;\n    requesterMemberRoleIds?: string[];\n    workspaceDir?: string;\n};\nexport type SubagentSpawnResult = {\n    status: "accepted" | "forbidden" | "error";\n    childSessionKey?: string;\n    runId?: string;\n    mode?: "run" | "session";\n    taskName?: string;\n    note?: string;\n    modelApplied?: boolean;\n    error?: string;\n    attachments?: unknown;\n};\n',
    patchId,
  );
  const patched = replaceOnce(
    withSpawnTypes,
    '    subagent: {\n        run: (params: SubagentRunParams) => Promise<SubagentRunResult>;',
    '    subagent: {\n        spawn: (params: SubagentSpawnParams) => Promise<SubagentSpawnResult>;\n        run: (params: SubagentRunParams) => Promise<SubagentRunResult>;',
    patchId,
  );
  if (!patched.includes('spawn: (params: SubagentSpawnParams) => Promise<SubagentSpawnResult>;')) {
    throw new Error(`${patchId}: runtime types verification failed`);
  }
  return patched;
}

function patchNativeSubagentRootRuntimeTypes(source, patchId) {
  const withSpawnTypes = replaceOnce(
    source,
    'type SubagentRunResult = {\n  runId: string;\n};\n',
    'type SubagentRunResult = {\n  runId: string;\n};\ntype SubagentSpawnParams = {\n  task: string;\n  taskName?: string;\n  label?: string;\n  agentId?: string;\n  model?: string;\n  thinking?: string;\n  runTimeoutSeconds?: number;\n  thread?: boolean;\n  mode?: "run" | "session";\n  cleanup?: "delete" | "keep";\n  sandbox?: "inherit" | "require";\n  context?: "isolated" | "fork";\n  lightContext?: boolean;\n  expectsCompletionMessage?: boolean;\n  attachments?: Array<Record<string, unknown>>;\n  attachMountPath?: string;\n  requesterSessionKey?: string;\n  requesterAgentId?: string;\n  requesterChannel?: string;\n  requesterAccountId?: string;\n  requesterTo?: string;\n  requesterThreadId?: string | number;\n  requesterGroupId?: string | null;\n  requesterGroupChannel?: string | null;\n  requesterGroupSpace?: string | null;\n  requesterMemberRoleIds?: string[];\n  workspaceDir?: string;\n};\ntype SubagentSpawnResult = {\n  status: "accepted" | "forbidden" | "error";\n  childSessionKey?: string;\n  runId?: string;\n  mode?: "run" | "session";\n  taskName?: string;\n  note?: string;\n  modelApplied?: boolean;\n  error?: string;\n  attachments?: unknown;\n};\n',
    patchId,
  );
  const withRuntimeSpawn = replaceOnce(
    withSpawnTypes,
    '  subagent: {\n    run: (params: SubagentRunParams) => Promise<SubagentRunResult>;',
    '  subagent: {\n    spawn: (params: SubagentSpawnParams) => Promise<SubagentSpawnResult>;\n    run: (params: SubagentRunParams) => Promise<SubagentRunResult>;',
    patchId,
  );
  const patched = replaceOnce(
    withRuntimeSpawn,
    'export { settleReplyDispatcher as a, SubagentRunResult as i, PluginRuntime as n, SubagentRunParams as r, CreatePluginRuntimeOptions as t };',
    'export { settleReplyDispatcher as a, SubagentRunResult as i, SubagentSpawnResult as j, PluginRuntime as n, SubagentRunParams as r, SubagentSpawnParams as s, CreatePluginRuntimeOptions as t };',
    patchId,
  );
  if (!patched.includes('spawn: (params: SubagentSpawnParams) => Promise<SubagentSpawnResult>;')) {
    throw new Error(`${patchId}: root runtime types verification failed`);
  }
  return patched;
}

function verifyNativeSubagentRuntimeUnavailablePatch(source, patchId) {
  if (!source.includes(SUBAGENT_RUNTIME_UNAVAILABLE_PATCHED_NEEDLE)) {
    throw new Error(`${patchId}: unavailable runtime verification failed`);
  }
}

function verifyNativeSubagentGatewayRuntimePatch(source, patchId) {
  for (const marker of [SUBAGENT_GATEWAY_RUNTIME_IMPORT_PATCHED_NEEDLE, 'async spawn(params) {', 'spawnSubagentDirect({']) {
    if (!source.includes(marker)) {
      throw new Error(`${patchId}: gateway runtime verification failed for ${marker}`);
    }
  }
}

function verifyNativeSubagentRuntimeProxyPatch(source, patchId) {
  if (!source.includes(SUBAGENT_RUNTIME_PROXY_PATCHED_NEEDLE)) {
    throw new Error(`${patchId}: runtime proxy verification failed`);
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
    id: 'native-subagent-runtime-spawn',
    apply: patchNativeSubagentRuntimeSpawn,
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
