import fs from 'node:fs';
import path from 'node:path';

import { REMOVED_BUNDLED_CHANNEL_PLUGIN_IDS } from './openclaw-bundled-channels.mjs';

const CUSTOM_PROVIDER_API_OWNER_HINT_NEEDLE = 'const normalizedProvider = normalizeProviderId(params.provider);\n\tif (!normalizedProvider) return;';
const CUSTOM_PROVIDER_API_OWNER_HINT_PATCHED_NEEDLE = 'const normalizedProvider = normalizeProviderId(params.provider);\n\tif (!normalizedProvider || normalizedProvider.startsWith("custom-")) return;';
const CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_NEEDLE = 'function shouldDeferSyntheticProfileAuth(params) {\n\tconst providerConfig = resolveProviderConfig(params.cfg, params.provider);';
const CUSTOM_PROVIDER_SYNTHETIC_PROFILE_DEFER_PATCHED_NEEDLE = 'function shouldDeferSyntheticProfileAuth(params) {\n\tif (normalizeProviderId(params.provider).startsWith("custom-")) return false;\n\tconst providerConfig = resolveProviderConfig(params.cfg, params.provider);';
const OPENCLAW_MCP_STATUS_METHOD = 'mcpServerStatus/list';
const OPENCLAW_MCP_STATUS_DESCRIPTOR_NEEDLE = '\t{\n\t\tname: "chat.send",\n\t\tscope: "operator.write"\n\t},';
const OPENCLAW_MCP_STATUS_DESCRIPTOR_PATCHED_NEEDLE = `${OPENCLAW_MCP_STATUS_DESCRIPTOR_NEEDLE}\n\t{\n\t\tname: "${OPENCLAW_MCP_STATUS_METHOD}",\n\t\tscope: "operator.read"\n\t},`;
const OPENCLAW_MCP_STATUS_IMPORT_NEEDLE = 'import { t as createSubsystemLogger } from "./subsystem-BIvbRvCg.js";';
const OPENCLAW_MCP_STATUS_HANDLER_NEEDLE = 'const coreGatewayHandlers = {';
const OPENCLAW_MCP_STATUS_HANDLER_START_NEEDLE = 'const matchaMcpStatusGatewayHandlers = {';
const OPENCLAW_MCP_STATUS_HANDLER_PATCHED_NEEDLE = `const matchaMcpStatusGatewayHandlers = {
		"${OPENCLAW_MCP_STATUS_METHOD}": async ({ params, respond, context }) => {
			const log = context?.logGateway ?? createSubsystemLogger("gateway/mcp-status");
			const requestParams = params && typeof params === "object" && !Array.isArray(params) ? params : {};
			const sessionKey = typeof requestParams.sessionKey === "string" ? requestParams.sessionKey.trim() : "";
			log.debug("mcpServerStatus/list request sessionKey=" + (sessionKey || "<missing>"));
			if (!sessionKey) {
				log.warn("mcpServerStatus/list missing sessionKey");
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "mcpServerStatus/list requires sessionKey"));
				return;
			}
			try {
				const manager = getSessionMcpRuntimeManager();
				let runtime = typeof manager.getBySessionKey === "function" ? manager.getBySessionKey(sessionKey) : void 0;
				if (typeof manager.getOrCreate === "function") {
					let loadedSession;
					try {
						loadedSession = typeof loadSessionEntry === "function" ? loadSessionEntry(sessionKey) : void 0;
					} catch (error) {
						log.debug("mcpServerStatus/list session lookup failed sessionKey=" + sessionKey + " error=" + formatErrorMessage(error));
					}
					const runtimeConfig = context?.getRuntimeConfig?.();
					const sessionConfig = runtimeConfig ?? loadedSession?.cfg;
					const canonicalSessionKey = typeof loadedSession?.canonicalKey === "string" && loadedSession.canonicalKey.trim() ? loadedSession.canonicalKey.trim() : sessionKey;
					const sessionEntry = loadedSession?.entry && typeof loadedSession.entry === "object" ? loadedSession.entry : {};
					const sessionId = typeof sessionEntry.sessionId === "string" && sessionEntry.sessionId.trim() ? sessionEntry.sessionId.trim() : "";
					const sessionAgentId = typeof resolveAgentIdFromSessionKey === "function" ? resolveAgentIdFromSessionKey(canonicalSessionKey) : void 0;
					const spawnedBy = sessionAgentId && typeof canonicalizeSpawnedByForAgent === "function" ? canonicalizeSpawnedByForAgent(sessionConfig, sessionAgentId, sessionEntry.spawnedBy) : sessionEntry.spawnedBy;
					const workspaceInfo = sessionConfig && typeof resolveSessionRuntimeWorkspace === "function" ? resolveSessionRuntimeWorkspace({
						cfg: sessionConfig,
						sessionKey: canonicalSessionKey,
						sessionEntry,
						spawnedBy
					}) : void 0;
					const workspaceDir = workspaceInfo?.runtimeWorkspaceDir ?? (sessionConfig && sessionAgentId && typeof resolveAgentWorkspaceDir === "function" ? resolveAgentWorkspaceDir(sessionConfig, sessionAgentId) : void 0);
					if (sessionId && sessionConfig && workspaceDir) {
						runtime = await manager.getOrCreate({
							sessionId,
							sessionKey: canonicalSessionKey,
							workspaceDir,
							cfg: sessionConfig
						});
						if (canonicalSessionKey !== sessionKey && typeof manager.bindSessionKey === "function") {
							manager.bindSessionKey(sessionKey, sessionId);
						}
					}
				}
				const catalog = runtime && typeof runtime.getCatalog === "function" ? await runtime.getCatalog() : runtime && typeof runtime.getCachedCatalog === "function" ? runtime.getCachedCatalog() : void 0;
				const serverRecords = catalog?.servers && typeof catalog.servers === "object" && !Array.isArray(catalog.servers) ? Object.values(catalog.servers) : [];
				log.debug("mcpServerStatus/list resolved sessionKey=" + sessionKey + " runtime=" + (runtime ? "hit" : "miss") + " catalog=" + (catalog ? "hit" : "miss") + " servers=" + serverRecords.length);
				respond(true, {
					data: serverRecords.map((server) => ({
						name: server.serverName,
						serverName: server.serverName,
						launchSummary: server.launchSummary,
						toolCount: server.toolCount,
						available: true
					}))
				}, void 0);
			} catch (error) {
				log.warn("mcpServerStatus/list failed sessionKey=" + sessionKey + " error=" + formatErrorMessage(error));
				respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
			}
		}
	};
	${OPENCLAW_MCP_STATUS_HANDLER_NEEDLE}`;
const OPENCLAW_MCP_STATUS_CODEX_HANDLER_PATCHED_NEEDLE = `const matchaMcpStatusGatewayHandlers = {\n\t"${OPENCLAW_MCP_STATUS_METHOD}": async ({ params, respond, context }) => {\n\t\tconst cfg = context.getRuntimeConfig();\n\t\tconst pluginConfig = cfg.plugins?.entries?.codex?.config;\n\t\tconst runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig });\n\t\tconst requestParams = params && typeof params === "object" && !Array.isArray(params) ? params : {};\n\t\ttry {\n\t\t\tconst result = await requestCodexAppServerJson({\n\t\t\t\tmethod: "${OPENCLAW_MCP_STATUS_METHOD}",\n\t\t\t\trequestParams,\n\t\t\t\ttimeoutMs: runtime.requestTimeoutMs,\n\t\t\t\tstartOptions: runtime.start,\n\t\t\t\tconfig: cfg\n\t\t\t});\n\t\t\trespond(true, result, void 0);\n\t\t} catch (error) {\n\t\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));\n\t\t}\n\t}\n};\n${OPENCLAW_MCP_STATUS_HANDLER_NEEDLE}`;
const OPENCLAW_MCP_STATUS_RUNTIME_CACHED_CATALOG_NEEDLE = '\t\tgetCatalog,';
const OPENCLAW_MCP_STATUS_RUNTIME_CACHED_CATALOG_PATCHED_NEEDLE = '\t\tgetCachedCatalog() {\n\t\t\treturn catalog;\n\t\t},\n\t\tgetCatalog,';
const OPENCLAW_MCP_STATUS_RUNTIME_MANAGER_ACCESS_NEEDLE = '\t\tresolveSessionId(sessionKey) {\n\t\t\treturn sessionIdBySessionKey.get(sessionKey);\n\t\t},';
const OPENCLAW_MCP_STATUS_RUNTIME_MANAGER_ACCESS_PATCHED_NEEDLE = `${OPENCLAW_MCP_STATUS_RUNTIME_MANAGER_ACCESS_NEEDLE}\n\t\tgetBySessionId(sessionId) {\n\t\t\treturn runtimesBySessionId.get(sessionId);\n\t\t},\n\t\tgetBySessionKey(sessionKey) {\n\t\t\tconst sessionId = sessionIdBySessionKey.get(sessionKey);\n\t\t\treturn sessionId ? runtimesBySessionId.get(sessionId) : void 0;\n\t\t},`;
const OPENCLAW_MCP_STATUS_CORE_HANDLER_NEEDLE = '\t...chatHandlers,';
const OPENCLAW_MCP_STATUS_CORE_HANDLER_PATCHED_NEEDLE = `${OPENCLAW_MCP_STATUS_CORE_HANDLER_NEEDLE}\n\t...matchaMcpStatusGatewayHandlers,`;

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

function readExportAlias(filePath, exportName, patchId) {
  const source = readText(filePath);
  const exportPattern = new RegExp(`export \\{[^}]*${exportName} as ([A-Za-z_$][\\w$]*)[^}]*\\}`);
  const match = source.match(exportPattern);
  if (!match) {
    throw new Error(`${patchId}: expected ${exportName} export alias in ${path.basename(filePath)}`);
  }
  return match[1];
}

function removeCodexMcpStatusImports(source) {
  return source.replace(
    /\nimport \{ [A-Za-z_$][\w$]* as resolveCodexAppServerRuntimeOptions \} from "\.\/config-[^"]+\.js";\nimport \{ [A-Za-z_$][\w$]* as requestCodexAppServerJson \} from "\.\/request-[^"]+\.js";/,
    '',
  );
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

function patchOpenClawMcpStatusGatewayMethod(openclawDir) {
  const patchId = 'openclaw-mcp-status-gateway-method';
  const distDir = path.join(openclawDir, 'dist');
  if (!fs.existsSync(distDir)) {
    return { status: 'skipped', detail: 'dist not found' };
  }

  const descriptorTarget = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'core-descriptors-',
    markers: [
      'const CORE_GATEWAY_METHOD_SPECS = [',
      'function createCoreGatewayMethodDescriptors(handlers)',
      'gateway method handler is missing a descriptor',
    ],
  });
  const serverMethodsTarget = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'server-methods-',
    markers: [
      'const coreGatewayHandlers = {',
      '...chatHandlers,',
      'function createRequestGatewayMethodRegistry(extraHandlers)',
    ],
  });
  const runtimeTarget = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'pi-bundle-mcp-runtime-',
    markers: [
      'function createSessionMcpRuntime(params)',
      'function getSessionMcpRuntimeManager()',
      'getCatalog,',
      'resolveSessionId(sessionKey)',
    ],
  });
  const runtimeRelativePath = path.relative(path.dirname(serverMethodsTarget), runtimeTarget).replace(/\\/g, '/');
  const runtimeImportPath = runtimeRelativePath.startsWith('.') ? runtimeRelativePath : `./${runtimeRelativePath}`;
  const runtimeManagerAlias = readExportAlias(runtimeTarget, 'getSessionMcpRuntimeManager', patchId);
  const importPatchedNeedle = `${OPENCLAW_MCP_STATUS_IMPORT_NEEDLE}\nimport { ${runtimeManagerAlias} as getSessionMcpRuntimeManager } from "${runtimeImportPath}";`;

  const descriptorBefore = readText(descriptorTarget);
  const serverMethodsBefore = readText(serverMethodsTarget);
  const runtimeBefore = readText(runtimeTarget);
  const descriptorAlreadyPatched = descriptorBefore.includes(OPENCLAW_MCP_STATUS_DESCRIPTOR_PATCHED_NEEDLE);
  const serverMethodsAlreadyPatched = serverMethodsBefore.includes(OPENCLAW_MCP_STATUS_HANDLER_PATCHED_NEEDLE)
    && serverMethodsBefore.includes(OPENCLAW_MCP_STATUS_CORE_HANDLER_PATCHED_NEEDLE)
    && serverMethodsBefore.includes(importPatchedNeedle)
    && !serverMethodsBefore.includes(OPENCLAW_MCP_STATUS_CODEX_HANDLER_PATCHED_NEEDLE);
  const runtimeAlreadyPatched = runtimeBefore.includes(OPENCLAW_MCP_STATUS_RUNTIME_CACHED_CATALOG_PATCHED_NEEDLE)
    && runtimeBefore.includes(OPENCLAW_MCP_STATUS_RUNTIME_MANAGER_ACCESS_PATCHED_NEEDLE);
  if (descriptorAlreadyPatched && serverMethodsAlreadyPatched && runtimeAlreadyPatched) {
    return { status: 'clean', detail: `${path.relative(openclawDir, descriptorTarget)}, ${path.relative(openclawDir, serverMethodsTarget)}, ${path.relative(openclawDir, runtimeTarget)}` };
  }

  const descriptorSource = descriptorAlreadyPatched
    ? descriptorBefore
    : replaceOnce(
      descriptorBefore,
      OPENCLAW_MCP_STATUS_DESCRIPTOR_NEEDLE,
      OPENCLAW_MCP_STATUS_DESCRIPTOR_PATCHED_NEEDLE,
      patchId,
    );
  let serverMethodsSource = removeCodexMcpStatusImports(serverMethodsBefore);
  if (!serverMethodsSource.includes(importPatchedNeedle)) {
    serverMethodsSource = replaceOnce(
      serverMethodsSource,
      OPENCLAW_MCP_STATUS_IMPORT_NEEDLE,
      importPatchedNeedle,
      patchId,
    );
  }
  if (serverMethodsSource.includes(OPENCLAW_MCP_STATUS_CODEX_HANDLER_PATCHED_NEEDLE)) {
    serverMethodsSource = replaceOnce(
      serverMethodsSource,
      OPENCLAW_MCP_STATUS_CODEX_HANDLER_PATCHED_NEEDLE,
      OPENCLAW_MCP_STATUS_HANDLER_PATCHED_NEEDLE,
      patchId,
    );
  }
  if (!serverMethodsSource.includes(OPENCLAW_MCP_STATUS_HANDLER_PATCHED_NEEDLE)) {
    if (serverMethodsSource.includes(OPENCLAW_MCP_STATUS_HANDLER_START_NEEDLE)) {
      const handlerStart = serverMethodsSource.indexOf(OPENCLAW_MCP_STATUS_HANDLER_START_NEEDLE);
      const handlerEnd = serverMethodsSource.indexOf(OPENCLAW_MCP_STATUS_HANDLER_NEEDLE, handlerStart);
      if (handlerEnd === -1) {
        throw new Error(`${patchId}: expected core handler after MCP status handler`);
      }
      serverMethodsSource = `${serverMethodsSource.slice(0, handlerStart)}${OPENCLAW_MCP_STATUS_HANDLER_PATCHED_NEEDLE}${serverMethodsSource.slice(handlerEnd + OPENCLAW_MCP_STATUS_HANDLER_NEEDLE.length)}`;
    } else {
      serverMethodsSource = replaceOnce(
        serverMethodsSource,
        OPENCLAW_MCP_STATUS_HANDLER_NEEDLE,
        OPENCLAW_MCP_STATUS_HANDLER_PATCHED_NEEDLE,
        patchId,
      );
    }
  }
  if (!serverMethodsSource.includes(OPENCLAW_MCP_STATUS_CORE_HANDLER_PATCHED_NEEDLE)) {
    serverMethodsSource = replaceOnce(
      serverMethodsSource,
      OPENCLAW_MCP_STATUS_CORE_HANDLER_NEEDLE,
      OPENCLAW_MCP_STATUS_CORE_HANDLER_PATCHED_NEEDLE,
      patchId,
    );
  }
  let runtimeSource = runtimeBefore;
  if (!runtimeSource.includes(OPENCLAW_MCP_STATUS_RUNTIME_CACHED_CATALOG_PATCHED_NEEDLE)) {
    runtimeSource = replaceOnce(
      runtimeSource,
      OPENCLAW_MCP_STATUS_RUNTIME_CACHED_CATALOG_NEEDLE,
      OPENCLAW_MCP_STATUS_RUNTIME_CACHED_CATALOG_PATCHED_NEEDLE,
      patchId,
    );
  }
  if (!runtimeSource.includes(OPENCLAW_MCP_STATUS_RUNTIME_MANAGER_ACCESS_PATCHED_NEEDLE)) {
    runtimeSource = replaceOnce(
      runtimeSource,
      OPENCLAW_MCP_STATUS_RUNTIME_MANAGER_ACCESS_NEEDLE,
      OPENCLAW_MCP_STATUS_RUNTIME_MANAGER_ACCESS_PATCHED_NEEDLE,
      patchId,
    );
  }

  verifyOpenClawMcpStatusGatewayMethodPatch(descriptorSource, serverMethodsSource, runtimeSource, importPatchedNeedle, patchId);
  writeText(descriptorTarget, descriptorSource);
  writeText(serverMethodsTarget, serverMethodsSource);
  writeText(runtimeTarget, runtimeSource);
  return { status: 'applied', detail: `${path.relative(openclawDir, descriptorTarget)}, ${path.relative(openclawDir, serverMethodsTarget)}, ${path.relative(openclawDir, runtimeTarget)}` };
}

function verifyOpenClawMcpStatusGatewayMethodPatch(descriptorSource, serverMethodsSource, runtimeSource, importPatchedNeedle, patchId) {
  if (!descriptorSource.includes(OPENCLAW_MCP_STATUS_DESCRIPTOR_PATCHED_NEEDLE)) {
    throw new Error(`${patchId}: descriptor verification failed`);
  }
  if (!serverMethodsSource.includes(importPatchedNeedle)
    || !serverMethodsSource.includes(OPENCLAW_MCP_STATUS_HANDLER_PATCHED_NEEDLE)
    || !serverMethodsSource.includes(OPENCLAW_MCP_STATUS_CORE_HANDLER_PATCHED_NEEDLE)
    || serverMethodsSource.includes(OPENCLAW_MCP_STATUS_CODEX_HANDLER_PATCHED_NEEDLE)) {
    throw new Error(`${patchId}: server method verification failed`);
  }
  if (!runtimeSource.includes(OPENCLAW_MCP_STATUS_RUNTIME_CACHED_CATALOG_PATCHED_NEEDLE)
    || !runtimeSource.includes(OPENCLAW_MCP_STATUS_RUNTIME_MANAGER_ACCESS_PATCHED_NEEDLE)) {
    throw new Error(`${patchId}: runtime manager verification failed`);
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
    id: 'openclaw-mcp-status-gateway-method',
    apply: patchOpenClawMcpStatusGatewayMethod,
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
