import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyOpenClawBundlePatches } from '../../scripts/openclaw-bundle-patches.mjs';

const tempRoots: string[] = [];
const RETIRED_PATCH_IDS = [
  'custom-provider-skip-api-owner-hint',
  'custom-provider-skip-synthetic-profile-defer',
  'openclaw-web-login-contract',
];

const READ_TOOL_FIXTURE = `
function wrapReadToolWithSkillContent(tool, skills, options) {
	const cwd = options?.cwd ?? process.cwd();
	const resolveInstructionPath = (filePath) => {
		if (filePath.startsWith("node://")) return filePath;
		return filePath;
	};
	const instructionContent = new Map();
	const readContent = (filePath) => {
		const content = instructionContent.get(filePath);
		if (content === void 0) throw Object.assign(/* @__PURE__ */ new Error(\`Virtual skill file not found: \${filePath}\`), { code: "ENOENT" });
		return content;
	};
	const instructionTool = typeof instructionContent.get(instructionPath) === "string" ? virtualRead ??= createOpenClawReadTool(eraseSessionFileTool(createReadTool("/", {
				operations: {
					resolvePath: (filePath) => filePath,
					access: async (filePath) => void readContent(filePath),
					readFile: async (filePath) => Buffer.from(readContent(filePath), "utf8")
				}
	})), options) : tool;
	if (!normalizedPath || !instructionPath || !instructionContent.has(instructionPath)) return tool.execute(toolCallId, args, signal, onUpdate);
}
`;

const SKILL_LOADER_FIXTURE = `
//#region src/skills/runtime/snapshot-config-fingerprint.ts
function loadSkillEntries(workspaceDir, opts) {
	const cacheKey = JSON.stringify([
		workspaceDir,
		process.env.OPENCLAW_STATE_DIR,
		getSkillsSnapshotVersion(workspaceDir)
	]);
	const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
	const managedSkills = workspaceOnly ? [] : loadSkills({
		dir: managedSkillsDir,
		source: "openclaw-managed"
	});
	for (const record of managedSkills) mergeRecord(record);
}
`;

const WORKSPACE_BOOTSTRAP_FIXTURE = `
//#region src/agents/workspace.ts
const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
const DEFAULT_SOUL_FILENAME = "SOUL.md";
const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
const DEFAULT_USER_FILENAME = "USER.md";
const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
const OPTIONAL_BOOTSTRAP_FILENAMES = new Set([DEFAULT_SOUL_FILENAME, DEFAULT_IDENTITY_FILENAME, DEFAULT_USER_FILENAME]);
async function readWorkspaceFileWithGuards(params) {
	return params;
}
async function ensureAgentWorkspace(params) {
	const dir = resolveUserPath(params.dir);
	const agentsPath = path.join(dir, DEFAULT_AGENTS_FILENAME);
	const soulPath = path.join(dir, DEFAULT_SOUL_FILENAME);
	const identityPath = path.join(dir, DEFAULT_IDENTITY_FILENAME);
	const userPath = path.join(dir, DEFAULT_USER_FILENAME);
	const isBrandNewWorkspace = await (async () => {
		const paths = [...[
			agentsPath,
			soulPath,
			identityPath,
			userPath
		], path.join(dir, "memory")];
		return (await Promise.all(paths.map(async (p) => {
			try {
				await fs.access(p);
				return true;
			} catch {
				return false;
			}
		}))).every((v) => !v) && !await hasWorkspaceUserContentEvidence(dir);
	})();
	const skipOptionalBootstrapFiles = new Set(params?.skipOptionalBootstrapFiles ?? []);
	const shouldWriteBootstrapFile = (fileName) => !OPTIONAL_BOOTSTRAP_FILENAMES.has(fileName) || !skipOptionalBootstrapFiles.has(fileName);
	await publishBootstrapFile(agentsPath, agentsTemplate, beforePersistentApply);
	if (!state.bootstrapSeededAt && !state.setupCompletedAt && !bootstrapExists) {
		if ((recentAttestation ? await workspaceRequiredBootstrapLooksCustomized(dir, { generatedHashes: recentAttestation.generatedHashes }) : false) || await workspaceProfileLooksConfigured({
			dir,
			includeGitEvidence: !reseedingExpiredWorkspaceState
		})) markState({ setupCompletedAt: nowIso() });
	}
	return isBrandNewWorkspace;
}
async function loadWorkspaceBootstrapFiles(dir) {
	const resolvedDir = resolveUserPath(dir);
	const entries = [
		{
			name: DEFAULT_AGENTS_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME)
		},
		{
			name: DEFAULT_SOUL_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_SOUL_FILENAME)
		},
		{
			name: DEFAULT_USER_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_USER_FILENAME)
		},
		{
			name: DEFAULT_MEMORY_FILENAME,
			filePath: path.join(resolvedDir, DEFAULT_MEMORY_FILENAME)
		}
	];
	const result = [];
	for (const entry of entries) {
		if ((entry.name === DEFAULT_MEMORY_FILENAME || entry.name === "USER.md") && !await exactWorkspaceEntryExists(resolvedDir, entry.name)) continue;
		const loaded = await readWorkspaceFileWithGuards({
			filePath: entry.filePath,
			workspaceDir: resolvedDir
		});
		if (loaded.ok) {
			const file = {
				name: entry.name,
				path: entry.filePath,
				content: loaded.content,
				missing: false
			};
			setWorkspaceFileSourceIdentity(file, loaded.sourceIdentity);
			result.push(file);
		} else if (isRootFileMissingFailure(loaded)) result.push({
			name: entry.name,
			path: entry.filePath,
			missing: true
		});
	}
	return result;
}
`;

const BOOTSTRAP_CACHE_FIXTURE = `
import { l as loadWorkspaceBootstrapFiles } from "./workspace-test.js";
//#region src/agents/bootstrap-cache.ts
async function getOrLoadBootstrapFiles(params) {
	const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
	return files;
}
`;

const PROVIDER_FETCH_FIXTURE = `
//#region src/agents/provider-transport-fetch.ts
function buildGuardedModelFetch(model, timeoutMs, options) {
	const requestConfig = resolveModelRequestPolicy(model);
	return async (input, init) => {
		const request = input instanceof Request ? new Request(input, init) : void 0;
		const rawHeaders = request?.headers ?? init?.headers;
		const swappedEgress = swapSecretSentinelsForEgress({
			url: rawUrl,
			headers: rawHeaders
		});
		const baseInit = { headers: swappedEgress.headers };
		const guardedFetchOptions = {
			url: rawUrl,
			init: baseInit,
		};
		return fetchWithSsrFGuard(guardedFetchOptions);
	};
}
`;

const SESSION_ACCESSOR_FIXTURE = `
function loadSessionEntry(scope) {
	return scope;
}
function patchSessionEntryCore(scope, update, options = {}) {
	return update(scope, options);
}
export { patchSessionEntryCore as d, loadSessionEntry as l };
`;

const AGENT_RUN_REGISTRY_FIXTURE = `
function getAgentRunContext(runId) {
	return { runId };
}
export { getAgentRunContext as c };
`;

const TRANSCRIPT_WRITE_CONTEXT_FIXTURE = `
function getOwnedSessionTranscriptWriterFence(params = {}) {
	return params;
}
export { getOwnedSessionTranscriptWriterFence as o };
`;

const METHOD_SCOPES_FIXTURE = `
const CORE_GATEWAY_METHOD_SPECS = [
	[
		"tools.effective",
		"tools-effective",
		"operator.read",
		"<=2026.7",
		{ startup: true }
	],
	[
		"tools.invoke",
		"tools-invoke",
		"operator.write",
		"<=2026.7"
	]
];
function listCoreAdvertisedGatewayMethodNames() { return CORE_GATEWAY_METHOD_SPECS.map(([name]) => name); }
`;

const TOOLS_EFFECTIVE_FIXTURE = `
import { p as peekSessionMcpRuntime } from "./agent-bundle-mcp-manager-api-test.js";
import { loadSessionEntry } from "./session-accessor.sqlite-entry-test.js";
const ErrorCodes = { INVALID_REQUEST: "INVALID_REQUEST" };
function errorShape(code, message) { return { code, message }; }
function normalizeOptionalString(value) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
const defaultToolsEffectiveDependencies = {
	peekSessionMcpRuntime,
	loadGatewaySessionEntryReadOnly: loadSessionEntry,
	resolveSessionAgentId: () => "main",
	resolveAgentWorkspaceDir: () => "/workspace",
	resolveSessionMcpConfigSummary: (params) => ({ fingerprint: "fp", serverNames: Object.keys(params.cfg?.mcp?.servers ?? { github: {} }) })
};
async function handleToolsEffectiveRequest(params) { params.respond(true, { groups: [] }, undefined); }
function createToolsEffectiveHandlers(dependencies = defaultToolsEffectiveDependencies) {
	return { "tools.effective": async ({ params, respond, context }) => {
		await handleToolsEffectiveRequest({
			rawParams: params,
			respond,
			context,
			dependencies
		});
	} };
}
export { createToolsEffectiveHandlers };
`;

const MCP_MANAGER_API_FIXTURE = `
function peekSessionMcpRuntime() { return undefined; }
export { peekSessionMcpRuntime as p };
`;

function createTempOpenClawPackage(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matcha-openclaw-patches-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'dist', 'extensions'), { recursive: true });
  return root;
}

function seedExtension(openclawDir: string, pluginId: string): string {
  const pluginDir = path.join(openclawDir, 'dist', 'extensions', pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: pluginId }));
  return pluginDir;
}

function seedDistFile(openclawDir: string, fileName: string, source: string): string {
  const filePath = path.join(openclawDir, 'dist', fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
  return filePath;
}

function seedOpenClawBundleFixtures(openclawDir: string): {
  readFile: string;
  loaderFile: string;
  workspaceFile: string;
  bootstrapCacheFile: string;
  providerFetchFile: string;
} {
  const readFile = seedDistFile(openclawDir, 'agent-tools.read-test.js', READ_TOOL_FIXTURE);
  const loaderFile = seedDistFile(openclawDir, 'workspace-skill-loader-test.js', SKILL_LOADER_FIXTURE);
  const workspaceFile = seedDistFile(openclawDir, 'workspace-test.js', WORKSPACE_BOOTSTRAP_FIXTURE);
  seedDistFile(openclawDir, 'bootstrap-cache-test.js', BOOTSTRAP_CACHE_FIXTURE);
  const providerFetchFile = seedDistFile(openclawDir, 'provider-transport-fetch-test.js', PROVIDER_FETCH_FIXTURE);
  seedDistFile(openclawDir, 'session-accessor.sqlite-entry-test.js', SESSION_ACCESSOR_FIXTURE);
  seedDistFile(openclawDir, 'method-scopes-test.js', METHOD_SCOPES_FIXTURE);
  seedDistFile(openclawDir, 'tools-effective-test.js', TOOLS_EFFECTIVE_FIXTURE);
  seedDistFile(openclawDir, 'agent-bundle-mcp-manager-api-test.js', MCP_MANAGER_API_FIXTURE);
  seedDistFile(openclawDir, 'agent-run-registry-test.js', AGENT_RUN_REGISTRY_FIXTURE);
  seedDistFile(openclawDir, 'transcript-write-context-test.js', TRANSCRIPT_WRITE_CONTEXT_FIXTURE);
  return {
    readFile,
    loaderFile,
    workspaceFile,
    bootstrapCacheFile: path.join(openclawDir, 'dist', 'bootstrap-cache-test.js'),
    providerFetchFile,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('openclaw bundle patches', () => {
  it('strips only the redundant bundled channel plugin', () => {
    const openclawDir = createTempOpenClawPackage();
    const feishuDir = seedExtension(openclawDir, 'feishu');
    const telegramDir = seedExtension(openclawDir, 'telegram');

    const results = applyOpenClawBundlePatches(openclawDir, {
      log: () => undefined,
      patchIds: ['strip-bundled-channel-plugins'],
    });

    expect(results).toEqual([expect.objectContaining({
      id: 'strip-bundled-channel-plugins',
      status: 'applied',
      detail: 'feishu',
    })]);
    expect(fs.existsSync(feishuDir)).toBe(false);
    expect(fs.existsSync(telegramDir)).toBe(true);
  });

  it('keeps bundled channel stripping idempotent', () => {
    const openclawDir = createTempOpenClawPackage();

    const results = applyOpenClawBundlePatches(openclawDir, {
      log: () => undefined,
      patchIds: ['strip-bundled-channel-plugins'],
    });

    expect(results).toEqual([expect.objectContaining({
      id: 'strip-bundled-channel-plugins',
      status: 'clean',
    })]);
  });

  it('patches OpenClaw sealed skill discovery, read routing, and agent bootstrap', () => {
    const openclawDir = createTempOpenClawPackage();
    const {
      readFile,
      loaderFile,
      workspaceFile,
      bootstrapCacheFile,
      providerFetchFile,
    } = seedOpenClawBundleFixtures(openclawDir);

    const results = applyOpenClawBundlePatches(openclawDir, {
      log: () => undefined,
      patchIds: ['matcha-sealed-skills'],
    });
    const readSource = fs.readFileSync(readFile, 'utf8');
    const loaderSource = fs.readFileSync(loaderFile, 'utf8');
    const workspaceSource = fs.readFileSync(workspaceFile, 'utf8');
    const bootstrapCacheSource = fs.readFileSync(bootstrapCacheFile, 'utf8');
    const providerFetchSource = fs.readFileSync(providerFetchFile, 'utf8');

    expect(results).toEqual([expect.objectContaining({
      id: 'matcha-sealed-skills',
      status: 'applied',
    })]);
    expect(readSource).toContain('function readMatchaSealedSkillFile(');
    expect(readSource).toContain('function rememberMatchaSealedSkillMeteringBinding(');
    expect(readSource).toContain('rememberMatchaSealedSkillMeteringBinding(body.meteringBinding);');
    expect(readSource).toContain('filePath.startsWith(MATCHA_SEALED_SKILL_PREFIX)');
    expect(loaderSource).toContain('function loadMatchaSealedSkillRecords(');
    expect(loaderSource).toContain('metadata: JSON.stringify({ openclaw: { skillKey } })');
    expect(loaderSource).not.toContain('metadata: JSON.stringify({ skillKey })');
    expect(loaderSource).toContain('const managedSkillKeys = new Set(managedSkills.map((record) => resolveSkillKey(record.skill, record)));');
    expect(loaderSource.indexOf('for (const record of sealedSkills) mergeRecord(record);')).toBeLessThan(loaderSource.indexOf('for (const record of managedSkills) mergeRecord(record);'));
    expect(workspaceSource).toContain('function loadMatchaSealedAgentBootstrapFile(');
    expect(workspaceSource).toContain('MATCHA_SEALED_AGENT_EXTENSION = ".matcha-agentpkg"');
    expect(workspaceSource).toContain('function matchaSealedAgentFilenames()');
    expect(workspaceSource).not.toContain('const MATCHA_SEALED_AGENT_FILENAMES');
    expect(workspaceSource).toContain('"/api/sealed-agents/read/" + encodeURIComponent(agentKey)');
    expect(workspaceSource).toContain('const sealedAgentKeys = matchaSealedAgentPackageKeys(resolvedDir);');
    expect(workspaceSource).toContain('if (matchaSealedAgentPackageKeys(dir).length > 0) return {');
    expect(workspaceSource).toContain('bootstrapPending: false');
    expect(workspaceSource).toContain('function rememberMatchaSealedAgentMeteringBinding(');
    expect(workspaceSource).toContain('patchSessionEntryCore({ sessionKey }');
    expect(workspaceSource).toContain('agentBindings:');
    expect(workspaceSource).toContain('loadMatchaSealedAgentBootstrapFile(resolvedDir, agentKey, entry.name, sessionKey);');
    expect(bootstrapCacheSource).toContain('loadWorkspaceBootstrapFiles(params.workspaceDir, params.sessionKey)');
    expect(providerFetchSource).toContain('function mergeMatchaPackageMeteringHeader(');
    expect(providerFetchSource).toContain('function mergeMatchaPackageMeteringInit(');
    expect(providerFetchSource).toContain('init: mergeMatchaPackageMeteringInit(baseInit),');
    expect(providerFetchSource).toContain('result.set("x-matcha-package-metering", JSON.stringify(normalized));');
  });

  it('upgrades already-patched sealed skill loader metadata and priority', () => {
    const openclawDir = createTempOpenClawPackage();
    const { loaderFile } = seedOpenClawBundleFixtures(openclawDir);

    applyOpenClawBundlePatches(openclawDir, {
      log: () => undefined,
      patchIds: ['matcha-sealed-skills'],
    });
    fs.writeFileSync(
      loaderFile,
      fs.readFileSync(loaderFile, 'utf8')
        .replace('metadata: JSON.stringify({ openclaw: { skillKey } })', 'metadata: JSON.stringify({ skillKey })')
        .replace(
          'for (const record of sealedSkills) mergeRecord(record);\n\tfor (const record of managedSkills) mergeRecord(record);',
          'for (const record of managedSkills) mergeRecord(record);\n\tfor (const record of sealedSkills) mergeRecord(record);',
        )
        .replace(
          'const managedSkillKeys = new Set(managedSkills.map((record) => resolveSkillKey(record.skill, record)));\n\tconst sealedSkills = workspaceOnly ? [] : loadMatchaSealedSkillRecords(managedSkillsDir).filter((record) => !managedSkillKeys.has(resolveSkillKey(record.skill, record)));',
          'const sealedSkills = workspaceOnly ? [] : loadMatchaSealedSkillRecords(managedSkillsDir);',
        ),
    );

    const results = applyOpenClawBundlePatches(openclawDir, {
      log: () => undefined,
      patchIds: ['matcha-sealed-skills'],
    });
    const loaderSource = fs.readFileSync(loaderFile, 'utf8');

    expect(results).toEqual([expect.objectContaining({
      id: 'matcha-sealed-skills',
      status: 'applied',
    })]);
    expect(loaderSource).toContain('metadata: JSON.stringify({ openclaw: { skillKey } })');
    expect(loaderSource).not.toContain('metadata: JSON.stringify({ skillKey })');
    expect(loaderSource).toContain('const managedSkillKeys = new Set(managedSkills.map((record) => resolveSkillKey(record.skill, record)));');
    expect(loaderSource.indexOf('for (const record of sealedSkills) mergeRecord(record);')).toBeLessThan(loaderSource.indexOf('for (const record of managedSkills) mergeRecord(record);'));
  });

  it('keeps OpenClaw sealed skill patch idempotent', () => {
    const openclawDir = createTempOpenClawPackage();
    seedOpenClawBundleFixtures(openclawDir);

    applyOpenClawBundlePatches(openclawDir, {
      log: () => undefined,
      patchIds: ['matcha-sealed-skills'],
    });
    const results = applyOpenClawBundlePatches(openclawDir, {
      log: () => undefined,
      patchIds: ['matcha-sealed-skills'],
    });

    expect(results).toEqual([expect.objectContaining({
      id: 'matcha-sealed-skills',
      status: 'clean',
    })]);
  });

  it('upgrades early sealed agent filename set initialization', () => {
    const openclawDir = createTempOpenClawPackage();
    const { workspaceFile } = seedOpenClawBundleFixtures(openclawDir);

    applyOpenClawBundlePatches(openclawDir, {
      log: () => undefined,
      patchIds: ['matcha-sealed-skills'],
    });
    fs.writeFileSync(
      workspaceFile,
      fs.readFileSync(workspaceFile, 'utf8')
        .replace(
          /let matchaSealedAgentFilenameSet;\nfunction matchaSealedAgentFilenames\(\) \{\n  return matchaSealedAgentFilenameSet \?\?= \/\* @__PURE__ \*\/ new Set\(\[DEFAULT_AGENTS_FILENAME, DEFAULT_SOUL_FILENAME, DEFAULT_USER_FILENAME, DEFAULT_MEMORY_FILENAME\]\);\n\}/,
          'const MATCHA_SEALED_AGENT_FILENAMES = /* @__PURE__ */ new Set([DEFAULT_AGENTS_FILENAME, DEFAULT_SOUL_FILENAME, DEFAULT_USER_FILENAME, DEFAULT_MEMORY_FILENAME]);',
        )
        .replaceAll('matchaSealedAgentFilenames().has(', 'MATCHA_SEALED_AGENT_FILENAMES.has('),
    );

    const results = applyOpenClawBundlePatches(openclawDir, {
      log: () => undefined,
      patchIds: ['matcha-sealed-skills'],
    });
    const workspaceSource = fs.readFileSync(workspaceFile, 'utf8');

    expect(results).toEqual([expect.objectContaining({
      id: 'matcha-sealed-skills',
      status: 'applied',
    })]);
    expect(workspaceSource).toContain('function matchaSealedAgentFilenames()');
    expect(workspaceSource).not.toContain('const MATCHA_SEALED_AGENT_FILENAMES');
    expect(workspaceSource).toContain('matchaSealedAgentFilenames().has(entry.name)');
  });

  it('patches MCP session status and next-run enablement methods', () => {
    const openclawDir = createTempOpenClawPackage();
    seedOpenClawBundleFixtures(openclawDir);

    const results = applyOpenClawBundlePatches(openclawDir, {
      log: () => undefined,
      patchIds: ['mcp-server-status-method'],
    });

    const scopesSource = fs.readFileSync(path.join(openclawDir, 'dist', 'method-scopes-test.js'), 'utf8');
    const toolsSource = fs.readFileSync(path.join(openclawDir, 'dist', 'tools-effective-test.js'), 'utf8');
    expect(results).toEqual([expect.objectContaining({
      id: 'mcp-server-status-method',
      status: 'applied',
    })]);
    expect(scopesSource).toContain('"mcpServerStatus/list"');
    expect(scopesSource).toContain('"mcpSessionServers/update"');
    expect(scopesSource).toContain('"operator.write"');
    expect(toolsSource).toContain('patchSessionEntryCore');
    expect(toolsSource).toContain('function projectMcpSessionServers(');
    expect(toolsSource).toContain('"mcpSessionServers/update"');
    expect(toolsSource).toContain('summary.serverNames.includes(parsed.serverName)');
    expect(toolsSource).toContain('effectiveNextRun: true');
  });

  it('keeps MCP session management patch idempotent', () => {
    const openclawDir = createTempOpenClawPackage();
    seedOpenClawBundleFixtures(openclawDir);

    applyOpenClawBundlePatches(openclawDir, {
      log: () => undefined,
      patchIds: ['mcp-server-status-method'],
    });
    const results = applyOpenClawBundlePatches(openclawDir, {
      log: () => undefined,
      patchIds: ['mcp-server-status-method'],
    });

    expect(results).toEqual([expect.objectContaining({
      id: 'mcp-server-status-method',
      status: 'clean',
    })]);
  });

  it('does not allow retired OpenClaw logic patches to be requested', () => {
    const openclawDir = createTempOpenClawPackage();

    for (const patchId of RETIRED_PATCH_IDS) {
      expect(() => applyOpenClawBundlePatches(openclawDir, {
        log: () => undefined,
        patchIds: [patchId],
      })).toThrow(`unknown OpenClaw patch id(s): ${patchId}`);
    }
  });

  it('keeps retired patch code only in the archive reference', () => {
    const archivePath = path.join(process.cwd(), 'scripts', 'archive', 'openclaw-retired-bundle-patches.mjs');
    const archive = fs.readFileSync(archivePath, 'utf8');

    expect(archive).toContain('只作历史参考');
    expect(archive).toContain('openclaw-web-login-contract');
  });
});
