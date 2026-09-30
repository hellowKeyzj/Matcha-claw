import fs from 'node:fs';
import path from 'node:path';

import { safeRmSync } from './lib/safe-delete.mjs';
import { REMOVED_BUNDLED_CHANNEL_PLUGIN_IDS } from './openclaw-bundled-channels.mjs';

const DEFAULT_PATCH_IDS = Object.freeze(['strip-bundled-channel-plugins', 'matcha-sealed-skills', 'opencode-go-session-header', 'mcp-server-status-method', 'provider-config-debug-trace', 'explicit-session-model-patch', 'agent-delete-cleanup-identity-string']);

function printLine(message = '') {
  process.stdout.write(`${message}\n`);
}

function listFilesByExtension(rootDir, extension) {
  const files = [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesByExtension(fullPath, extension));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      files.push(fullPath);
    }
  }
  return files;
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath, source) {
  fs.writeFileSync(filePath, source);
}

function locateSingleJavaScriptFile(distDir, patchId, options) {
  return locateSingleFile(distDir, patchId, { ...options, extensions: ['.js', '.mjs'] });
}

function locateSingleFile(distDir, patchId, options) {
  const { fileNamePrefix, markers } = options;
  const extensions = options.extensions ?? [options.extension];
  const candidates = extensions.flatMap((extension) => listFilesByExtension(distDir, extension)).filter((filePath) => (
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

function replaceOptionalOnce(source, needle, replacement, patchId) {
  if (source.includes(replacement)) {
    return { source, changed: false };
  }
  if (!source.includes(needle)) {
    return { source, changed: false };
  }
  return { source: replaceOnce(source, needle, replacement, patchId), changed: true };
}

function replaceBlockOnce(source, startNeedle, endNeedle, replacement, patchId) {
  if (source.includes(replacement)) return { source, changed: false };
  const start = source.indexOf(startNeedle);
  if (start < 0) return { source, changed: false };
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (end < 0) return { source, changed: false };
  if (source.indexOf(startNeedle, start + startNeedle.length) >= 0) {
    throw new Error(`${patchId}: expected one block start match`);
  }
  return {
    source: `${source.slice(0, start)}${replacement}${source.slice(end + endNeedle.length)}`,
    changed: true,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveExportAlias(filePath, exportedName, patchId) {
  const source = readText(filePath);
  const escaped = escapeRegExp(exportedName);
  const aliased = source.match(new RegExp(`\\b${escaped}\\s+as\\s+([A-Za-z_$][\\w$]*)\\b`));
  if (aliased) return aliased[1];
  if (new RegExp(`export\\s+\\{[^}]*\\b${escaped}\\b[^}]*\\}`).test(source)) return exportedName;
  throw new Error(`${patchId}: expected ${exportedName} export in ${path.basename(filePath)}`);
}

function relativeImportSpecifier(fromFile, toFile) {
  let specifier = path.relative(path.dirname(fromFile), toFile).replaceAll(path.sep, '/');
  if (!specifier.startsWith('.')) specifier = `./${specifier}`;
  return specifier;
}

function ensureNamedImport(source, targetFile, dependencyFile, exportedName, localName, patchId) {
  const specifier = relativeImportSpecifier(targetFile, dependencyFile);
  const alias = resolveExportAlias(dependencyFile, exportedName, patchId);
  const importLine = alias === localName
    ? `import { ${alias} } from "${specifier}";`
    : `import { ${alias} as ${localName} } from "${specifier}";`;
  if (source.includes(importLine)) return { source, changed: false };
  const imports = [...source.matchAll(/^import .+;$/gm)];
  if (imports.length === 0) return { source: `${importLine}\n${source}`, changed: true };
  const last = imports.at(-1);
  const insertAt = last.index + last[0].length;
  return {
    source: `${source.slice(0, insertAt)}\n${importLine}${source.slice(insertAt)}`,
    changed: true,
  };
}

const MATCHA_METERING_BINDING_HELPERS = `function cloneMatchaMeteringBinding(value) {
  if (typeof value === "string") return value.trim() || void 0;
  if (!value || typeof value !== "object") return;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return;
  }
}
function keyMatchaMeteringBinding(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return typeof value === "string" ? value : void 0;
  }
}
function normalizeMatchaMeteringBindings(value) {
  const values = Array.isArray(value) ? value : [value];
  const result = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of values) {
    const binding = cloneMatchaMeteringBinding(item);
    const key = binding === void 0 ? void 0 : keyMatchaMeteringBinding(binding);
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(binding);
    }
  }
  return result;
}`;

const MATCHA_METERING_RUNTIME_HELPERS = `const MATCHA_METERING_STATE_KEY = Symbol.for("matcha.openclaw.packageMetering");
function matchaMeteringState() {
  const existing = globalThis[MATCHA_METERING_STATE_KEY];
  if (existing && existing.skillBindingsByRunId instanceof Map) return existing;
  const state = { skillBindingsByRunId: /* @__PURE__ */ new Map() };
  globalThis[MATCHA_METERING_STATE_KEY] = state;
  return state;
}`;

function stripBundledChannelPlugins(openclawDir) {
  const extensionsDir = path.join(openclawDir, 'dist', 'extensions');
  if (!fs.existsSync(extensionsDir)) {
    return { status: 'skipped', detail: 'dist/extensions not found' };
  }

  const removed = [];
  for (const pluginId of REMOVED_BUNDLED_CHANNEL_PLUGIN_IDS) {
    const target = path.join(extensionsDir, pluginId);
    if (!fs.existsSync(target)) continue;
    safeRmSync(target, { root: extensionsDir });
    removed.push(pluginId);
  }
  return removed.length > 0
    ? { status: 'applied', detail: removed.join(', ') }
    : { status: 'clean', detail: 'already removed' };
}

function patchMatchaSealedSkills(openclawDir) {
  const patchId = 'matcha-sealed-skills';
  const distDir = path.join(openclawDir, 'dist');
  const readFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'agent-tools.read-',
    markers: [
      'function wrapReadToolWithSkillContent(tool, skills, options)',
      'Virtual skill file not found:',
      'const instructionContent = new Map',
    ],
  });
  const loaderFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'workspace-skill-loader-',
    markers: [
      'function loadSkillEntries(workspaceDir, opts)',
      'const managedSkills = workspaceOnly ? [] : loadSkills({',
      'for (const record of managedSkills) mergeRecord(record);',
    ],
  });
  const workspaceFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'workspace-',
    markers: [
      'async function loadWorkspaceBootstrapFiles(dir',
      'async function readWorkspaceFileWithGuards(params)',
      'setWorkspaceFileSourceIdentity(file, loaded.sourceIdentity);',
    ],
  });
  const bootstrapCacheFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'bootstrap-cache-',
    markers: [
      'async function getOrLoadBootstrapFiles(params)',
      'const files = await loadWorkspaceBootstrapFiles(params.workspaceDir',
    ],
  });
  const providerFetchFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'provider-transport-fetch-',
    markers: [
      'function buildGuardedModelFetch(model',
      'const swappedEgress = swapSecretSentinelsForEgress({',
      'fetchWithSsrFGuard(',
    ],
  });
  const sessionAccessorFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'session-accessor.sqlite-entry-',
    markers: [
      'function loadSessionEntry(scope)',
      'function patchSessionEntryCore(scope, update, options = {})',
    ],
  });
  const agentRunRegistryFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'agent-run-registry-',
    markers: [
      'function getAgentRunContext(runId)',
    ],
  });
  const transcriptWriteContextFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'transcript-write-context-',
    markers: [
      'function getOwnedSessionTranscriptWriterFence(params = {})',
    ],
  });

  const readChanged = patchSealedSkillReadTool(readFile, transcriptWriteContextFile, patchId);
  const loaderChanged = patchSealedSkillLoader(loaderFile, patchId);
  const agentChanged = patchSealedAgentBootstrap(workspaceFile, sessionAccessorFile, patchId);
  const cacheChanged = patchBootstrapCacheSessionKey(bootstrapCacheFile, patchId);
  const headerChanged = patchModelFetchMeteringHeader(providerFetchFile, sessionAccessorFile, agentRunRegistryFile, transcriptWriteContextFile, patchId);
  return readChanged || loaderChanged || agentChanged || cacheChanged || headerChanged
    ? { status: 'applied', detail: `${path.basename(readFile)}, ${path.basename(loaderFile)}, ${path.basename(workspaceFile)}, ${path.basename(bootstrapCacheFile)}, ${path.basename(providerFetchFile)}` }
    : { status: 'clean', detail: 'already patched' };
}

function patchSealedSkillReadTool(filePath, transcriptWriteContextFile, patchId) {
  let source = readText(filePath);
  let changed = false;
  const importPatch = ensureNamedImport(
    source,
    filePath,
    transcriptWriteContextFile,
    'getOwnedSessionTranscriptWriterFence',
    'getOwnedSessionTranscriptWriterFence',
    patchId,
  );
  source = importPatch.source;
  changed ||= importPatch.changed;
  const meteringHelper = `${MATCHA_METERING_BINDING_HELPERS}
${MATCHA_METERING_RUNTIME_HELPERS}
function rememberMatchaSealedSkillMeteringBinding(value) {
  const bindings = normalizeMatchaMeteringBindings(value);
  if (bindings.length === 0) return;
  const runId = getOwnedSessionTranscriptWriterFence()?.expectedWriterRunId?.trim();
  if (!runId) return;
  const state = matchaMeteringState();
  const current = state.skillBindingsByRunId.get(runId) ?? [];
  const seen = /* @__PURE__ */ new Set(current.map((binding) => keyMatchaMeteringBinding(binding)).filter(Boolean));
  for (const binding of bindings) {
    const key = keyMatchaMeteringBinding(binding);
    if (key && !seen.has(key)) {
      seen.add(key);
      current.push(binding);
    }
  }
  state.skillBindingsByRunId.set(runId, current);
}`;
  const helper = `
${meteringHelper}
const MATCHA_SEALED_SKILL_PREFIX = "matcha-skill://";
function matchaSealedSkillEndpoint() {
  const endpoint = process.env.MATCHA_SEALED_ENDPOINT?.trim();
  const token = process.env.MATCHA_SEALED_TOKEN?.trim();
  const runtime = process.env.MATCHA_SEALED_RUNTIME?.trim();
  if (!endpoint || !token || runtime !== "openclaw") throw Object.assign(new Error("Matcha sealed skill runtime is unavailable"), { code: "ENOENT" });
  return { endpoint: endpoint.replace(/\\/+$/u, ""), token, runtime };
}
function encodeMatchaSealedPath(pathValue) {
  return pathValue.split("/").map((part) => encodeURIComponent(part)).join("/");
}
function matchaSealedSkillRequestPath(filePath) {
  if (!filePath.startsWith(MATCHA_SEALED_SKILL_PREFIX)) return;
  const rest = filePath.slice(MATCHA_SEALED_SKILL_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return;
  const skillKey = decodeURIComponent(rest.slice(0, slash));
  const relativePath = rest.slice(slash + 1).split("/").map((part) => decodeURIComponent(part)).join("/");
  if (!skillKey || !relativePath) return;
  return "/api/sealed-skills/read/" + encodeURIComponent(skillKey) + "/" + encodeMatchaSealedPath(relativePath);
}
async function readMatchaSealedSkillFile(filePath, signal) {
  const requestPath = matchaSealedSkillRequestPath(filePath);
  if (!requestPath) throw Object.assign(new Error("Invalid sealed skill path: " + filePath), { code: "ENOENT" });
  const sealed = matchaSealedSkillEndpoint();
  const response = await fetch(sealed.endpoint + requestPath, {
    method: "GET",
    signal,
    headers: {
      "x-matcha-sealed-token": sealed.token,
      "x-matcha-sealed-runtime": sealed.runtime
    }
  });
  if (response.status === 404) throw Object.assign(new Error("Virtual skill file not found: " + filePath), { code: "ENOENT" });
  if (!response.ok) throw new Error("Sealed skill read failed: " + response.status);
  const body = await response.json();
  if (!body || typeof body.contentBase64 !== "string") throw new Error("Sealed skill read returned an invalid payload");
  rememberMatchaSealedSkillMeteringBinding(body.meteringBinding);
  return Buffer.from(body.contentBase64, "base64").toString("utf8");
}
`;
  if (!source.includes('function readMatchaSealedSkillFile(')) {
    source = replaceOnce(
      source,
      'function wrapReadToolWithSkillContent(tool, skills, options) {',
      `${helper}\nfunction wrapReadToolWithSkillContent(tool, skills, options) {`,
      patchId,
    );
    source = replaceVirtualPathGuard(source, patchId);
    source = replaceOnce(
      source,
      'if (!normalizedPath || !instructionPath || !instructionContent.has(instructionPath)) return tool.execute(toolCallId, args, signal, onUpdate);',
      'if (!normalizedPath || !instructionPath || !instructionContent.has(instructionPath) && !instructionPath.startsWith(MATCHA_SEALED_SKILL_PREFIX)) return tool.execute(toolCallId, args, signal, onUpdate);',
      patchId,
    );
    const readContentPatch = replaceBlockOnce(
      source,
      'const readContent = (filePath) => {',
      '\n\t};',
      `const readContent = async (filePath, signal) => {
			const content = instructionContent.get(filePath);
			if (typeof content === "string") return content;
			if (filePath.startsWith(MATCHA_SEALED_SKILL_PREFIX)) return readMatchaSealedSkillFile(filePath, signal);
			throw Object.assign(/* @__PURE__ */ new Error(\`Virtual skill file not found: \${filePath}\`), { code: "ENOENT" });
		};`,
      patchId,
    );
    source = readContentPatch.source;
    source = replaceOnce(
      source,
      'const instructionTool = typeof instructionContent.get(instructionPath) === "string" ? virtualRead ??= createOpenClawReadTool(eraseSessionFileTool(createReadTool("/", {',
      'const instructionTool = typeof instructionContent.get(instructionPath) === "string" || instructionPath.startsWith(MATCHA_SEALED_SKILL_PREFIX) ? virtualRead ??= createOpenClawReadTool(eraseSessionFileTool(createReadTool("/", {',
      patchId,
    );
    const virtualReadPattern = /access: async \(filePath\) => void readContent\(filePath\),\n(\s*)readFile: async \(filePath\) => Buffer\.from\(readContent\(filePath\), "utf8"\)/g;
    const virtualReadMatches = [...source.matchAll(virtualReadPattern)];
    if (virtualReadMatches.length !== 1) {
      throw new Error(`${patchId}: expected one virtual read operation match, found ${virtualReadMatches.length}`);
    }
    source = source.replace(
      virtualReadPattern,
      `access: async (filePath) => { await readContent(filePath, signal); },\n${virtualReadMatches[0][1]}readFile: async (filePath) => Buffer.from(await readContent(filePath, signal), "utf8")`,
    );
    changed = true;
  } else if (!source.includes('function rememberMatchaSealedSkillMeteringBinding(')) {
    source = replaceOnce(
      source,
      'const MATCHA_SEALED_SKILL_PREFIX = "matcha-skill://";',
      `${meteringHelper}\nconst MATCHA_SEALED_SKILL_PREFIX = "matcha-skill://";`,
      patchId,
    );
    changed = true;
  }
  const endpointTrimPatch = replaceOptionalOnce(
    source,
    'return { endpoint: endpoint.replace(//+$/u, ""), token, runtime };',
    'return { endpoint: endpoint.replace(/\\/+$/u, ""), token, runtime };',
    patchId,
  );
  source = endpointTrimPatch.source;
  changed ||= endpointTrimPatch.changed;
  const bindingPatch = replaceOptionalOnce(
    source,
    `  if (!body || typeof body.contentBase64 !== "string") throw new Error("Sealed skill read returned an invalid payload");
  return Buffer.from(body.contentBase64, "base64").toString("utf8");`,
    `  if (!body || typeof body.contentBase64 !== "string") throw new Error("Sealed skill read returned an invalid payload");
  rememberMatchaSealedSkillMeteringBinding(body.meteringBinding);
  return Buffer.from(body.contentBase64, "base64").toString("utf8");`,
    patchId,
  );
  source = bindingPatch.source;
  changed ||= bindingPatch.changed;
  if (changed) writeText(filePath, source);
  return changed;
}

function replaceVirtualPathGuard(source, patchId) {
  if (source.includes('if (filePath.startsWith("node://") || filePath.startsWith(MATCHA_SEALED_SKILL_PREFIX)) return filePath;')) {
    return source;
  }
  if (source.includes('if (filePath.startsWith("node://")) return filePath;')) {
    return replaceOnce(
      source,
      'if (filePath.startsWith("node://")) return filePath;',
      'if (filePath.startsWith("node://") || filePath.startsWith(MATCHA_SEALED_SKILL_PREFIX)) return filePath;',
      patchId,
    );
  }
  const mappedNeedle = `const mapped = mapContainerPathToWorkspaceRoot({
				filePath,`;
  if (source.includes(mappedNeedle)) {
    return replaceOnce(
      source,
      mappedNeedle,
      `if (filePath.startsWith(MATCHA_SEALED_SKILL_PREFIX)) return filePath;
			const mapped = mapContainerPathToWorkspaceRoot({
				filePath,`,
      patchId,
    );
  }
  throw new Error(`${patchId}: expected read path guard target`);
}

function patchSealedSkillLoader(filePath, patchId) {
  let source = readText(filePath);
  let changed = false;
  const helper = `
const MATCHA_SEALED_SKILL_SOURCE = "matcha-sealed";
const MATCHA_SEALED_SKILL_EXTENSION = ".matcha-skillpkg";
function matchaSealedSkillPath(skillKey, relativePath = "SKILL.md") {
  return "matcha-skill://" + encodeURIComponent(skillKey) + "/" + relativePath.split("/").map((part) => encodeURIComponent(part)).join("/");
}
function matchaSealedSkillPackageFingerprint(dir) {
  if (!process.env.MATCHA_SEALED_ENDPOINT || !process.env.MATCHA_SEALED_TOKEN || process.env.MATCHA_SEALED_RUNTIME !== "openclaw") return "";
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(MATCHA_SEALED_SKILL_EXTENSION)).map((entry) => {
      const filePath = path.join(dir, entry.name);
      const stat = fs.statSync(filePath);
      return entry.name + ":" + stat.size + ":" + Math.trunc(stat.mtimeMs);
    }).sort().join("|");
  } catch {
    return "";
  }
}
function resolveLoadedSkillRecordKey(record) {
  return resolveSkillKey(record.skill, {
    metadata: resolveSkillEntryMetadata({
      frontmatter: record.frontmatter,
      skillDir: record.skill.baseDir
    })
  });
}
function loadMatchaSealedSkillRecords(dir) {
  if (!process.env.MATCHA_SEALED_ENDPOINT || !process.env.MATCHA_SEALED_TOKEN || process.env.MATCHA_SEALED_RUNTIME !== "openclaw") return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const records = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.endsWith(MATCHA_SEALED_SKILL_EXTENSION)) continue;
    const packagePath = path.join(dir, entry.name);
    let wire;
    try {
      wire = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    } catch {
      continue;
    }
    const manifest = wire?.manifest;
    if (wire?.format !== "matcha-skillpkg" || wire?.version !== 1 || manifest?.target !== "openclaw") continue;
    const skillKey = typeof manifest.skillKey === "string" ? manifest.skillKey.trim() : "";
    const descriptor = manifest.descriptor && typeof manifest.descriptor === "object" ? manifest.descriptor : void 0;
    const name = typeof descriptor?.name === "string" && descriptor.name.trim() || skillKey;
    const description = typeof descriptor?.description === "string" ? descriptor.description.trim() : "";
    if (!skillKey || !name || !description || seen.has(skillKey)) continue;
    seen.add(skillKey);
    const filePath = matchaSealedSkillPath(skillKey);
    const baseDir = filePath.slice(0, -"/SKILL.md".length);
    const frontmatter = {
      name,
      description,
      metadata: JSON.stringify({ openclaw: { skillKey } })
    };
    if (typeof descriptor.userInvocable === "boolean") frontmatter["user-invocable"] = String(descriptor.userInvocable);
    if (typeof descriptor.disableModelInvocation === "boolean") frontmatter["disable-model-invocation"] = String(descriptor.disableModelInvocation);
    const invocation = resolveSkillInvocationPolicy(frontmatter);
    records.push({
      skill: {
        name,
        displayName: name,
        description,
        locationNote: "Encrypted by Matcha. Read this SKILL.md and referenced files with the normal read tool at their exact matcha-skill:// paths.",
        skillCard: void 0,
        readContent: void 0,
        filePath,
        baseDir,
        source: MATCHA_SEALED_SKILL_SOURCE,
        sourceInfo: {
          path: filePath,
          source: MATCHA_SEALED_SKILL_SOURCE,
          scope: "project",
          origin: "top-level",
          baseDir
        },
        disableModelInvocation: invocation.disableModelInvocation
      },
      frontmatter,
      invocation,
      rejectHardlinks: true
    });
  }
  return records;
}
`;
  if (!source.includes('function loadMatchaSealedSkillRecords(')) {
    source = replaceOnce(
      source,
      '//#region src/skills/runtime/snapshot-config-fingerprint.ts',
      `${helper}\n//#region src/skills/runtime/snapshot-config-fingerprint.ts`,
      patchId,
    );
    changed = true;
  } else if (!source.includes('function resolveLoadedSkillRecordKey(')) {
    source = replaceOnce(
      source,
      'function loadMatchaSealedSkillRecords(dir) {',
      `function resolveLoadedSkillRecordKey(record) {
  return resolveSkillKey(record.skill, {
    metadata: resolveSkillEntryMetadata({
      frontmatter: record.frontmatter,
      skillDir: record.skill.baseDir
    })
  });
}
function loadMatchaSealedSkillRecords(dir) {`,
      patchId,
    );
    changed = true;
  }
  if (source.includes('metadata: JSON.stringify({ skillKey })')) {
    source = source.replaceAll(
      'metadata: JSON.stringify({ skillKey })',
      'metadata: JSON.stringify({ openclaw: { skillKey } })',
    );
    changed = true;
  }
  const syntheticSourceInfo = `sourceInfo: createSyntheticSourceInfo(filePath, {
          source: MATCHA_SEALED_SKILL_SOURCE,
          scope: "project",
          origin: "top-level",
          baseDir
        })`;
  const literalSourceInfo = `sourceInfo: {
          path: filePath,
          source: MATCHA_SEALED_SKILL_SOURCE,
          scope: "project",
          origin: "top-level",
          baseDir
        }`;
  if (source.includes(syntheticSourceInfo)) {
    source = source.replaceAll(syntheticSourceInfo, literalSourceInfo);
    changed = true;
  }
  const fingerprintNeedle = `process.env.OPENCLAW_STATE_DIR,
			getSkillsSnapshotVersion(workspaceDir)`;
  const fingerprintReplacement = `process.env.OPENCLAW_STATE_DIR,
			getSkillsSnapshotVersion(workspaceDir),
			matchaSealedSkillPackageFingerprint(opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills"))`;
  const fingerprintPatch = replaceOptionalOnce(source, fingerprintNeedle, fingerprintReplacement, patchId);
  source = fingerprintPatch.source;
  changed ||= fingerprintPatch.changed;
  const managedOnly = `	const managedSkills = workspaceOnly ? [] : loadSkills({
		dir: managedSkillsDir,
		source: "openclaw-managed"
	});`;
  const buggyManagedAndSealed = `${managedOnly}
	const sealedSkills = workspaceOnly ? [] : loadMatchaSealedSkillRecords(managedSkillsDir);`;
  const managedFilteredSealed = `${managedOnly}
	const managedSkillKeys = new Set(managedSkills.map((record) => resolveSkillKey(record.skill, record)));
	const sealedSkills = workspaceOnly ? [] : loadMatchaSealedSkillRecords(managedSkillsDir).filter((record) => !managedSkillKeys.has(resolveSkillKey(record.skill, record)));`;
  if (source.includes(managedFilteredSealed)) {
    source = replaceOnce(source, managedFilteredSealed, managedOnly, patchId);
    changed = true;
  } else if (source.includes(buggyManagedAndSealed)) {
    source = replaceOnce(source, buggyManagedAndSealed, managedOnly, patchId);
    changed = true;
  }
  const workspaceSkillsCompact = `	const workspaceSkills = loadSkills({ dir: workspaceSkillsDir, source: "openclaw-workspace" });`;
  const workspaceSkillsBlock = `	const workspaceSkills = loadSkills({
		dir: workspaceSkillsDir,
		source: "openclaw-workspace"
	});`;
  const allOrdinaryFilteredSealed = `	const ordinarySkillKeys = new Set([
		...bundledSkills,
		...custodianSkills,
		...extraSkills,
		...managedSkills,
		...workshopSkills,
		...personalAgentsSkills,
		...projectAgentsSkills,
		...workspaceSkills
	].map(resolveLoadedSkillRecordKey));
	const sealedSkills = workspaceOnly ? [] : loadMatchaSealedSkillRecords(managedSkillsDir).filter((record) => !ordinarySkillKeys.has(resolveLoadedSkillRecordKey(record)));`;
  if (!source.includes(allOrdinaryFilteredSealed)) {
    if (source.includes(workspaceSkillsBlock)) {
      source = replaceOnce(source, workspaceSkillsBlock, `${workspaceSkillsBlock}\n${allOrdinaryFilteredSealed}`, patchId);
    } else {
      source = replaceOnce(source, workspaceSkillsCompact, `${workspaceSkillsCompact}\n${allOrdinaryFilteredSealed}`, patchId);
    }
    changed = true;
  }
  const buggyOrder = `for (const record of managedSkills) mergeRecord(record);
	for (const record of sealedSkills) mergeRecord(record);`;
  const managedOrder = 'for (const record of managedSkills) mergeRecord(record);';
  if (source.includes(buggyOrder)) {
    source = replaceOnce(source, buggyOrder, managedOrder, patchId);
    changed = true;
  }
  const oldExpectedOrder = `for (const record of sealedSkills) mergeRecord(record);
	for (const record of managedSkills) mergeRecord(record);`;
  if (source.includes(oldExpectedOrder)) {
    source = replaceOnce(source, oldExpectedOrder, managedOrder, patchId);
    changed = true;
  }
  const extraMerge = 'for (const record of extraSkills) mergeRecord(record);';
  const sealedBeforeExtra = `for (const record of sealedSkills) mergeRecord(record);
	${extraMerge}`;
  if (!source.includes(sealedBeforeExtra)) {
    source = replaceOnce(source, extraMerge, sealedBeforeExtra, patchId);
    changed = true;
  }
  if (changed) writeText(filePath, source);
  return changed;
}

function patchSealedAgentBootstrap(filePath, sessionAccessorFile, patchId) {
  let source = readText(filePath);
  let changed = false;
  const importPatch = ensureNamedImport(
    source,
    filePath,
    sessionAccessorFile,
    'patchSessionEntryCore',
    'patchSessionEntryCore',
    patchId,
  );
  source = importPatch.source;
  changed ||= importPatch.changed;
  const filenameSetNeedle = 'const MATCHA_SEALED_AGENT_FILENAMES = /* @__PURE__ */ new Set([DEFAULT_AGENTS_FILENAME, DEFAULT_SOUL_FILENAME, DEFAULT_USER_FILENAME, DEFAULT_MEMORY_FILENAME]);';
  const filenameSetReplacement = `let matchaSealedAgentFilenameSet;
function matchaSealedAgentFilenames() {
  return matchaSealedAgentFilenameSet ??= /* @__PURE__ */ new Set([DEFAULT_AGENTS_FILENAME, DEFAULT_SOUL_FILENAME, DEFAULT_USER_FILENAME, DEFAULT_MEMORY_FILENAME]);
}`;
  const meteringHelper = `${MATCHA_METERING_BINDING_HELPERS}
async function rememberMatchaSealedAgentMeteringBinding(sessionKey, agentKey, value) {
  const bindings = normalizeMatchaMeteringBindings(value);
  if (!sessionKey || bindings.length === 0) return;
  await patchSessionEntryCore({ sessionKey }, (entry) => {
    const currentMetering = entry.matchaMetering && typeof entry.matchaMetering === "object" ? entry.matchaMetering : {};
    const currentAgentBindings = currentMetering.agentBindings && typeof currentMetering.agentBindings === "object" && !Array.isArray(currentMetering.agentBindings) ? currentMetering.agentBindings : {};
    const current = normalizeMatchaMeteringBindings(currentAgentBindings[agentKey]);
    const seen = /* @__PURE__ */ new Set(current.map((binding) => keyMatchaMeteringBinding(binding)).filter(Boolean));
    for (const binding of bindings) {
      const key = keyMatchaMeteringBinding(binding);
      if (key && !seen.has(key)) {
        seen.add(key);
        current.push(binding);
      }
    }
    return {
      matchaMetering: {
        ...currentMetering,
        agentBindings: {
          ...currentAgentBindings,
          [agentKey]: current
        }
      }
    };
  });
}`;
  if (source.includes('function loadMatchaSealedAgentBootstrapFile(')) {
    const upgrade = replaceOptionalOnce(source, filenameSetNeedle, filenameSetReplacement, patchId);
    source = upgrade.source;
    changed ||= upgrade.changed;
    const packageKeyEndpointPatch = replaceOptionalOnce(
      source,
      `function matchaSealedAgentPackageKeys(dir) {
  if (!matchaSealedAgentEndpoint()) return [];
  let entries;`,
      `function matchaSealedAgentPackageKeys(dir) {
  let entries;`,
      patchId,
    );
    source = packageKeyEndpointPatch.source;
    changed ||= packageKeyEndpointPatch.changed;
    if (source.includes('MATCHA_SEALED_AGENT_FILENAMES.has(')) {
      source = source.replaceAll('MATCHA_SEALED_AGENT_FILENAMES.has(', 'matchaSealedAgentFilenames().has(');
      changed = true;
    }
    if (!source.includes('function rememberMatchaSealedAgentMeteringBinding(')) {
      source = replaceOnce(
        source,
        'const MATCHA_SEALED_AGENT_EXTENSION = ".matcha-agentpkg";',
        `${meteringHelper}
const MATCHA_SEALED_AGENT_EXTENSION = ".matcha-agentpkg";`,
        patchId,
      );
      changed = true;
    }
  } else {
    const helper = `
${meteringHelper}
const MATCHA_SEALED_AGENT_EXTENSION = ".matcha-agentpkg";
${filenameSetReplacement}
function matchaSealedAgentEndpoint() {
  const endpoint = process.env.MATCHA_SEALED_ENDPOINT?.trim();
  const token = process.env.MATCHA_SEALED_TOKEN?.trim();
  const runtime = process.env.MATCHA_SEALED_RUNTIME?.trim();
  if (!endpoint || !token || runtime !== "openclaw") return;
  return { endpoint: endpoint.replace(/\\/+$/u, ""), token, runtime };
}
function encodeMatchaSealedAgentPath(pathValue) {
  return pathValue.split("/").map((part) => encodeURIComponent(part)).join("/");
}
function matchaSealedAgentPackageKeys(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const keys = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.endsWith(MATCHA_SEALED_AGENT_EXTENSION)) continue;
    let wire;
    try {
      wire = JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf8"));
    } catch {
      continue;
    }
    const manifest = wire?.manifest;
    const agentKey = typeof manifest?.agentKey === "string" ? manifest.agentKey.trim() : "";
    if (wire?.format !== "matcha-agentpkg" || wire?.version !== 1 || manifest?.target !== "openclaw" || !agentKey || seen.has(agentKey)) continue;
    seen.add(agentKey);
    keys.push(agentKey);
  }
  keys.sort();
  return keys;
}
async function loadMatchaSealedAgentBootstrapFile(workspaceDir, agentKey, name) {
  if (!matchaSealedAgentFilenames().has(name)) return;
  const sealed = matchaSealedAgentEndpoint();
  if (!sealed) return;
  const response = await fetch(sealed.endpoint + "/api/sealed-agents/read/" + encodeURIComponent(agentKey) + "/" + encodeMatchaSealedAgentPath(name), {
    method: "GET",
    headers: {
      "x-matcha-sealed-token": sealed.token,
      "x-matcha-sealed-runtime": sealed.runtime
    }
  });
  if (response.status === 404) return;
  if (!response.ok) throw new Error("Sealed agent bootstrap read failed: " + response.status);
  const body = await response.json();
  if (!body || typeof body.contentBase64 !== "string") throw new Error("Sealed agent bootstrap read returned an invalid payload");
  return {
    name,
    path: path.join(workspaceDir, name),
    content: Buffer.from(body.contentBase64, "base64").toString("utf8"),
    missing: false
  };
}
`;
  source = replaceOnce(
    source,
    '//#region src/agents/workspace.ts',
    `${helper}\n//#region src/agents/workspace.ts`,
    patchId,
  );
  source = replaceOnce(
    source,
    `async function loadWorkspaceBootstrapFiles(dir) {
	const resolvedDir = resolveUserPath(dir);`,
    `async function loadWorkspaceBootstrapFiles(dir) {
	const resolvedDir = resolveUserPath(dir);
	const sealedAgentKeys = matchaSealedAgentPackageKeys(resolvedDir);`,
    patchId,
  );
  source = replaceOnce(
    source,
    `	for (const entry of entries) {
		if ((entry.name === DEFAULT_MEMORY_FILENAME || entry.name === "USER.md") && !await exactWorkspaceEntryExists(resolvedDir, entry.name)) continue;`,
    `	for (const entry of entries) {
		const entryExists = await exactWorkspaceEntryExists(resolvedDir, entry.name);
		const optionalRootBootstrapFile = entry.name === DEFAULT_MEMORY_FILENAME || entry.name === DEFAULT_USER_FILENAME;
		if (optionalRootBootstrapFile && !entryExists && sealedAgentKeys.length === 0) continue;`,
    patchId,
  );
  source = replaceOnce(
    source,
    `		} else if (isRootFileMissingFailure(loaded)) result.push({
			name: entry.name,
			path: entry.filePath,
			missing: true
		});`,
    `		} else if (isRootFileMissingFailure(loaded)) {
			let sealedFile;
			if (matchaSealedAgentFilenames().has(entry.name)) {
				for (const agentKey of sealedAgentKeys) {
					sealedFile = await loadMatchaSealedAgentBootstrapFile(resolvedDir, agentKey, entry.name);
					if (sealedFile) break;
				}
			}
			if (sealedFile) result.push(sealedFile);
			else if (!optionalRootBootstrapFile) result.push({
				name: entry.name,
				path: entry.filePath,
				missing: true
			});
		}`,
    patchId,
  );
    changed = true;
  }
  const signaturePatch = replaceOptionalOnce(
    source,
    'async function loadMatchaSealedAgentBootstrapFile(workspaceDir, agentKey, name) {',
    'async function loadMatchaSealedAgentBootstrapFile(workspaceDir, agentKey, name, sessionKey) {',
    patchId,
  );
  source = signaturePatch.source;
  changed ||= signaturePatch.changed;
  const bindingPatch = replaceOptionalOnce(
    source,
    `  if (!body || typeof body.contentBase64 !== "string") throw new Error("Sealed agent bootstrap read returned an invalid payload");
  return {`,
    `  if (!body || typeof body.contentBase64 !== "string") throw new Error("Sealed agent bootstrap read returned an invalid payload");
  await rememberMatchaSealedAgentMeteringBinding(sessionKey, agentKey, body.meteringBinding);
  return {`,
    patchId,
  );
  source = bindingPatch.source;
  changed ||= bindingPatch.changed;
  const workspaceSignaturePatch = replaceOptionalOnce(
    source,
    'async function loadWorkspaceBootstrapFiles(dir) {',
    'async function loadWorkspaceBootstrapFiles(dir, sessionKey) {',
    patchId,
  );
  source = workspaceSignaturePatch.source;
  changed ||= workspaceSignaturePatch.changed;
  const sealedAgentWorkspaceSeedPatch = replaceOptionalOnce(
    source,
    `const userPath = path.join(dir, DEFAULT_USER_FILENAME);
	const isBrandNewWorkspace = await (async () => {`,
    `const userPath = path.join(dir, DEFAULT_USER_FILENAME);
	if (matchaSealedAgentPackageKeys(dir).length > 0) return {
		dir,
		agentsPath,
		soulPath,
		identityPath,
		userPath,
		bootstrapPath,
		bootstrapPending: false,
		identityPathCreated: false
	};
	const isBrandNewWorkspace = await (async () => {`,
    patchId,
  );
  source = sealedAgentWorkspaceSeedPatch.source;
  changed ||= sealedAgentWorkspaceSeedPatch.changed;
  if (source.includes('loadMatchaSealedAgentBootstrapFile(resolvedDir, agentKey, entry.name);')) {
    source = source.replaceAll(
      'loadMatchaSealedAgentBootstrapFile(resolvedDir, agentKey, entry.name);',
      'loadMatchaSealedAgentBootstrapFile(resolvedDir, agentKey, entry.name, sessionKey);',
    );
    changed = true;
  }
  if (changed) writeText(filePath, source);
  return changed;
}

function patchBootstrapCacheSessionKey(filePath, patchId) {
  let source = readText(filePath);
  const patch = replaceOptionalOnce(
    source,
    'const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);',
    'const files = await loadWorkspaceBootstrapFiles(params.workspaceDir, params.sessionKey);',
    patchId,
  );
  if (patch.changed) writeText(filePath, patch.source);
  return patch.changed;
}

function patchModelFetchMeteringHeader(filePath, sessionAccessorFile, agentRunRegistryFile, transcriptWriteContextFile, patchId) {
  let source = readText(filePath);
  let changed = false;
  for (const [dependencyFile, exportedName, localName] of [
    [sessionAccessorFile, 'loadSessionEntry', 'loadSessionEntry'],
    [agentRunRegistryFile, 'getAgentRunContext', 'getAgentRunContext'],
    [transcriptWriteContextFile, 'getOwnedSessionTranscriptWriterFence', 'getOwnedSessionTranscriptWriterFence'],
  ]) {
    const importPatch = ensureNamedImport(source, filePath, dependencyFile, exportedName, localName, patchId);
    source = importPatch.source;
    changed ||= importPatch.changed;
  }
  const helper = `${MATCHA_METERING_BINDING_HELPERS}
${MATCHA_METERING_RUNTIME_HELPERS}
function collectMatchaPackageMeteringBindings() {
  const runId = getOwnedSessionTranscriptWriterFence()?.expectedWriterRunId?.trim();
  if (!runId) return [];
  const runContext = getAgentRunContext(runId);
  const bindings = [];
  const agentBindings = runContext?.sessionKey ? loadSessionEntry({ sessionKey: runContext.sessionKey, agentId: runContext.agentId, clone: false })?.matchaMetering?.agentBindings : void 0;
  if (agentBindings && typeof agentBindings === "object") {
    for (const value of Object.values(agentBindings)) bindings.push(...normalizeMatchaMeteringBindings(value));
  }
  bindings.push(...normalizeMatchaMeteringBindings(matchaMeteringState().skillBindingsByRunId.get(runId)));
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const binding of bindings) {
    const key = keyMatchaMeteringBinding(binding);
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(binding);
    }
  }
  return result;
}
function mergeMatchaPackageMeteringHeader(headers) {
  const bindings = collectMatchaPackageMeteringBindings();
  if (bindings.length === 0) return headers;
  const result = new Headers(headers);
  const existing = result.get("x-matcha-package-metering");
  let merged = [];
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      merged = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      merged = [existing];
    }
  }
  merged.push(...bindings);
  const seen = /* @__PURE__ */ new Set();
  const normalized = [];
  for (const binding of merged) {
    const value = cloneMatchaMeteringBinding(binding);
    const key = value === void 0 ? void 0 : keyMatchaMeteringBinding(value);
    if (key && !seen.has(key)) {
      seen.add(key);
      normalized.push(value);
    }
  }
  result.set("x-matcha-package-metering", JSON.stringify(normalized));
  return result;
}
function mergeMatchaPackageMeteringInit(init) {
  const headers = mergeMatchaPackageMeteringHeader(init?.headers);
  return headers === init?.headers ? init : { ...init, headers };
}`;
  if (!source.includes('function mergeMatchaPackageMeteringHeader(')) {
    source = replaceOnce(
      source,
      '//#region src/agents/provider-transport-fetch.ts',
      `${helper}\n//#region src/agents/provider-transport-fetch.ts`,
      patchId,
    );
    changed = true;
  }
  const initPatch = replaceOptionalOnce(
    source,
    'init: baseInit,',
    'init: mergeMatchaPackageMeteringInit(baseInit),',
    patchId,
  );
  source = initPatch.source;
  changed ||= initPatch.changed;
  if (changed) writeText(filePath, source);
  return changed;
}

function patchOpencodeGoSessionHeader(openclawDir) {
  const patchId = 'opencode-go-session-header';
  const distDir = path.join(openclawDir, 'dist');
  const streamFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'stream-',
    markers: ['function createOpencodeGoAttributionWrapper(baseStreamFn, sourceApi)'],
  });
  const extraParamsFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'extra-params-',
    markers: ['const providerStreamBase = agent.streamFn;'],
  });
  const attemptFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'builtin-openclaw-',
    markers: ['preparedExtraParams: effectiveExtraParams,', 'sessionId: attempt.sessionId,'],
  });
  const compactionFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'compact-',
    markers: ['...preparedRuntimeExtraParams ? { preparedExtraParams: preparedRuntimeExtraParams } : {},'],
  });
  const original = readText(streamFile);
  let source = original;
  const needle = `		const api = sourceApi ?? model.api;
		if (model.provider !== "opencode-go" || api !== "anthropic-messages") return baseStreamFn(model, context, options);`;
  const replacement = `		if (model.provider !== "opencode-go") return baseStreamFn(model, context, options);
		const endpoint = URL.parse(model.baseUrl);
		if (endpoint?.origin === "https://opencode.ai" && ["/zen/go", "/zen/go/v1"].includes(endpoint.pathname.replace(/\\/+$/, ""))) {
			const sessionId = options?.sessionId?.trim();
			if (sessionId) {
				const headers = new Headers(options?.headers);
				headers.set("x-opencode-session", sessionId);
				options = { ...options, headers: Object.fromEntries(headers) };
			}
		}
		const api = sourceApi ?? model.api;
		if (api !== "anthropic-messages") return baseStreamFn(model, context, options);`;
  if (!source.includes(replacement)) source = replaceOnce(source, needle, replacement, patchId);
  // Thread the admitted session to the provider wrapper, which runs before the
  // embedded base stream enriches options. Header policy stays in the Go plugin.
  const edits = [[streamFile, original, source]];
  for (const [file, before, after] of [
    [attemptFile, 'preparedExtraParams: effectiveExtraParams,', 'sessionId: attempt.sessionId,\n\t\tpreparedExtraParams: effectiveExtraParams,'],
    [compactionFile, '...preparedRuntimeExtraParams ? { preparedExtraParams: preparedRuntimeExtraParams } : {},', 'sessionId: params.sessionId,\n\t\t\t...preparedRuntimeExtraParams ? { preparedExtraParams: preparedRuntimeExtraParams } : {},'],
    [extraParamsFile, 'agent.streamFn = pluginWrappedStreamFn ?? providerStreamBase;', `agent.streamFn = pluginWrappedStreamFn ?? providerStreamBase;
	if (provider === "opencode-go" && options?.sessionId && agent.streamFn) {
		const sessionStreamFn = agent.streamFn;
		const sessionId = options.sessionId;
		agent.streamFn = (model, context, streamOptions) => sessionStreamFn(model, context, streamOptions?.sessionId ? streamOptions : { ...streamOptions, sessionId });
	}`],
  ]) {
    const current = readText(file);
    edits.push([file, current, current.includes(after) ? current : replaceOnce(current, before, after, patchId)]);
  }
  const changed = edits.filter(([, before, after]) => before !== after);
  for (const [file, , after] of changed) writeText(file, after);
  return changed.length > 0
    ? { status: 'applied', detail: changed.map(([file]) => path.basename(file)).join(', ') }
    : { status: 'clean', detail: 'already patched' };
}

function patchMcpServerStatusMethod(openclawDir) {
  const patchId = 'mcp-server-status-method';
  const distDir = path.join(openclawDir, 'dist');
  const methodScopesFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'method-scopes-',
    markers: [
      'const CORE_GATEWAY_METHOD_SPECS = [',
      '"tools.effective",',
      'function listCoreAdvertisedGatewayMethodNames()',
    ],
  });
  const toolsEffectiveFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'tools-effective-',
    markers: [
      'const defaultToolsEffectiveDependencies = {',
      'peekSessionMcpRuntime,',
      'function createToolsEffectiveHandlers(dependencies = defaultToolsEffectiveDependencies)',
    ],
  });
  const sessionAccessorFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'session-accessor.sqlite-entry-',
    markers: [
      'function patchSessionEntryCore(',
      'function loadSessionEntry(',
    ],
  });

  const changed = [
    [methodScopesFile, patchMcpServerStatusMethodScope(methodScopesFile, patchId)],
    [toolsEffectiveFile, patchMcpServerStatusHandler(toolsEffectiveFile, sessionAccessorFile, patchId)],
  ].filter(([, changed]) => changed).map(([file]) => path.basename(file));

  return changed.length > 0
    ? { status: 'applied', detail: changed.join(', ') }
    : { status: 'clean', detail: 'already patched' };
}

function patchMcpServerStatusMethodScope(filePath, patchId) {
  const source = readText(filePath);
  const needle = `\t[\n\t\t"tools.effective",\n\t\t"tools-effective",\n\t\t"operator.read",\n\t\t"<=2026.7",\n\t\t{ startup: true }\n\t],\n\t[\n\t\t"tools.invoke",`;
  const replacement = `\t[\n\t\t"tools.effective",\n\t\t"tools-effective",\n\t\t"operator.read",\n\t\t"<=2026.7",\n\t\t{ startup: true }\n\t],\n\t[\n\t\t"mcpServerStatus/list",\n\t\t"tools-effective",\n\t\t"operator.read",\n\t\t"2026.9",\n\t\t{ startup: true }\n\t],\n\t[\n\t\t"mcpSessionServers/update",\n\t\t"tools-effective",\n\t\t"operator.write",\n\t\t"2026.9"\n\t],\n\t[\n\t\t"tools.invoke",`;
  let patch = replaceOptionalOnce(source, needle, replacement, patchId);
  const updateNeedle = `\t[\n\t\t"mcpServerStatus/list",\n\t\t"tools-effective",\n\t\t"operator.read",\n\t\t"2026.9",\n\t\t{ startup: true }\n\t],\n\t[\n\t\t"tools.invoke",`;
  const updateReplacement = `\t[\n\t\t"mcpServerStatus/list",\n\t\t"tools-effective",\n\t\t"operator.read",\n\t\t"2026.9",\n\t\t{ startup: true }\n\t],\n\t[\n\t\t"mcpSessionServers/update",\n\t\t"tools-effective",\n\t\t"operator.write",\n\t\t"2026.9"\n\t],\n\t[\n\t\t"tools.invoke",`;
  const updatePatch = replaceOptionalOnce(patch.source, updateNeedle, updateReplacement, patchId);
  patch = { source: updatePatch.source, changed: patch.changed || updatePatch.changed };
  if (patch.changed) writeText(filePath, patch.source);
  return patch.changed;
}

function patchMcpServerStatusHandler(filePath, sessionAccessorFile, patchId) {
  let source = readText(filePath);
  let changed = false;
  const importPatch = ensureNamedImport(source, filePath, sessionAccessorFile, 'patchSessionEntryCore', 'patchSessionEntryCore', patchId);
  source = importPatch.source;
  changed ||= importPatch.changed;

  const helper = `const MCP_SERVER_STATUS_DEFAULT_LIMIT = 100;
const MCP_SERVER_STATUS_MAX_LIMIT = 100;
function mcpServerStatusRuntimeLookup(sessionKey) {
\treturn sessionKey.includes(":") ? { sessionKey } : { sessionId: sessionKey, sessionKey };
}
function countMcpCatalogToolsByServer(tools) {
\tconst counts = /* @__PURE__ */ new Map();
\tfor (const tool of tools) {
\t\tconst serverName = typeof tool?.serverName === "string" ? tool.serverName : "";
\t\tif (serverName) counts.set(serverName, (counts.get(serverName) ?? 0) + 1);
\t}
\treturn counts;
}
function rejectMcpSessionControlRequest(respond, message) {
\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, message));
}
function readMcpSessionParams(rawParams, method, respond) {
\tif (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
\t\trejectMcpSessionControlRequest(respond, method + " params must be an object");
\t\treturn;
\t}
\tconst sessionKey = normalizeOptionalString(rawParams.sessionKey);
\tif (!sessionKey) {
\t\trejectMcpSessionControlRequest(respond, method + " requires a sessionKey");
\t\treturn;
\t}
\treturn sessionKey;
}
function readMcpServerStatusListParams(rawParams, respond) {
\tconst sessionKey = readMcpSessionParams(rawParams, "mcpServerStatus/list", respond);
\tif (!sessionKey) return;
\tconst limit = rawParams.limit ?? MCP_SERVER_STATUS_DEFAULT_LIMIT;
\tif (!Number.isInteger(limit) || limit < 1 || limit > MCP_SERVER_STATUS_MAX_LIMIT) {
\t\trejectMcpSessionControlRequest(respond, "mcpServerStatus/list limit must be an integer between 1 and 100");
\t\treturn;
\t}
\tif (rawParams.cursor !== void 0 && typeof rawParams.cursor !== "string") {
\t\trejectMcpSessionControlRequest(respond, "mcpServerStatus/list cursor must be a string");
\t\treturn;
\t}
\tconst cursor = normalizeOptionalString(rawParams.cursor);
\tif (cursor !== void 0 && !/^(0|[1-9]\\d*)$/u.test(cursor)) {
\t\trejectMcpSessionControlRequest(respond, "mcpServerStatus/list cursor is invalid");
\t\treturn;
\t}
\tconst detail = normalizeOptionalString(rawParams.detail);
\tif (detail !== void 0 && detail !== "toolsAndAuthOnly") {
\t\trejectMcpSessionControlRequest(respond, "mcpServerStatus/list detail is invalid");
\t\treturn;
\t}
\treturn { sessionKey, limit, offset: cursor === void 0 ? 0 : Number(cursor) };
}
function readMcpSessionUpdateParams(rawParams, respond) {
\tconst sessionKey = readMcpSessionParams(rawParams, "mcpSessionServers/update", respond);
\tif (!sessionKey) return;
\tconst serverName = normalizeOptionalString(rawParams.serverName);
\tif (!serverName) {
\t\trejectMcpSessionControlRequest(respond, "mcpSessionServers/update requires a serverName");
\t\treturn;
\t}
\tif (rawParams.enabled !== true && rawParams.enabled !== false) {
\t\trejectMcpSessionControlRequest(respond, "mcpSessionServers/update enabled must be boolean");
\t\treturn;
\t}
\treturn { sessionKey, serverName, enabled: rawParams.enabled };
}
function resolveMcpSessionContext(sessionKey, respond, dependencies) {
\tconst loaded = dependencies.loadGatewaySessionEntryReadOnly(sessionKey);
\tif (!loaded.entry) {
\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, 'unknown session key "' + sessionKey + '"'));
\t\treturn;
\t}
\tconst canonicalKey = loaded.canonicalKey ?? sessionKey;
\tconst agentId = dependencies.resolveSessionAgentId({ sessionKey: canonicalKey, config: loaded.cfg });
\tconst workspaceDir = normalizeOptionalString(loaded.entry.spawnedWorkspaceDir) ?? dependencies.resolveAgentWorkspaceDir(loaded.cfg, agentId);
\treturn { cfg: loaded.cfg, entry: loaded.entry, sessionId: loaded.entry.sessionId, sessionKey, workspaceDir, toolOverrides: loaded.entry.toolOverrides };
}
function mcpSessionConfigSummary(context, dependencies) {
\treturn dependencies.resolveSessionMcpConfigSummary({
\t\tworkspaceDir: context.workspaceDir,
\t\tcfg: context.cfg,
\t\t...(context.toolOverrides ? { toolOverrides: context.toolOverrides } : {})
\t});
}
function projectMcpSessionServers(context, runtime, dependencies, offset, limit) {
\tconst summary = mcpSessionConfigSummary(context, dependencies);
\tconst catalog = runtime?.retiredCatalog ?? runtime?.peekCatalog?.() ?? null;
\tconst catalogServers = catalog?.servers && typeof catalog.servers === "object" && !Array.isArray(catalog.servers) ? catalog.servers : {};
\tconst toolCounts = countMcpCatalogToolsByServer(Array.isArray(catalog?.tools) ? catalog.tools : []);
\tconst overrides = context.toolOverrides?.mcpServers ?? {};
\tconst names = [...new Set([...summary.serverNames, ...Object.keys(catalogServers), ...Object.keys(overrides)])].toSorted((left, right) => left.localeCompare(right));
\tconst stale = Boolean(runtime && runtime.configFingerprint !== summary.fingerprint);
\tconst data = names.slice(offset, offset + limit).map((name) => {
\t\tconst server = catalogServers[name];
\t\tconst enabled = overrides[name] !== false;
\t\tconst connected = enabled && Boolean(server) && !stale;
\t\tconst state = !enabled ? "disabled" : stale ? "stale-config" : server ? "connected" : runtime ? "listing-tools" : "not-connected";
\t\treturn {
\t\t\tname,
\t\t\tserverName: name,
\t\t\tstate,
\t\t\tenabled,
\t\t\tavailable: connected,
\t\t\ttoolCount: server ? toolCounts.get(name) ?? server.toolCount ?? 0 : void 0,
\t\t\tlaunchSummary: typeof server?.launchSummary === "string" ? server.launchSummary : void 0,
\t\t\teffectiveNextRun: !enabled || stale
\t\t};
\t});
\treturn { data, ...offset + limit < names.length ? { nextCursor: String(offset + limit) } : {} };
}
async function handleMcpServerStatusListRequest(params) {
\tconst parsed = readMcpServerStatusListParams(params.rawParams, params.respond);
\tif (!parsed) return;
\tconst context = resolveMcpSessionContext(parsed.sessionKey, params.respond, params.dependencies);
\tif (!context) return;
\tconst runtime = params.dependencies.peekSessionMcpRuntime(mcpServerStatusRuntimeLookup(parsed.sessionKey));
\tparams.respond(true, projectMcpSessionServers(context, runtime, params.dependencies, parsed.offset, parsed.limit), void 0);
}
async function handleMcpSessionServersUpdateRequest(params) {
	const parsed = readMcpSessionUpdateParams(params.rawParams, params.respond);
	if (!parsed) return;
	const context = resolveMcpSessionContext(parsed.sessionKey, params.respond, params.dependencies);
	if (!context) return;
	const summary = mcpSessionConfigSummary(context, params.dependencies);
	if (!summary.serverNames.includes(parsed.serverName)) {
		rejectMcpSessionControlRequest(params.respond, 'unknown MCP server "' + parsed.serverName + '"');
		return;
	}
	const existing = context.entry.toolOverrides ?? {};
	const mcpServers = { ...(existing.mcpServers ?? {}), [parsed.serverName]: parsed.enabled };
	const toolOverrides = { ...existing, mcpServers };
	await patchSessionEntryCore({ sessionKey: parsed.sessionKey }, () => ({ toolOverrides }), { skipMaintenance: true });
	params.respond(true, { serverName: parsed.serverName, enabled: parsed.enabled, effectiveNextRun: true }, void 0);
}
`;
  const helperTarget = 'async function handleToolsEffectiveRequest(params) {';
  const helperReplacement = `${helper}\n${helperTarget}`;
  const helperPatch = source.includes('const MCP_SERVER_STATUS_DEFAULT_LIMIT = 100;')
    ? replaceBlockOnce(source, 'const MCP_SERVER_STATUS_DEFAULT_LIMIT = 100;', helperTarget, helperReplacement, patchId)
    : replaceOptionalOnce(source, helperTarget, helperReplacement, patchId);
  source = helperPatch.source;
  changed ||= helperPatch.changed;

  const handlersNeedle = `function createToolsEffectiveHandlers(dependencies = defaultToolsEffectiveDependencies) {
\treturn { "tools.effective": async ({ params, respond, context }) => {
\t\tawait handleToolsEffectiveRequest({
\t\t\trawParams: params,
\t\t\trespond,
\t\t\tcontext,
\t\t\tdependencies
\t\t});
\t} };
}`;
  const handlersReplacement = `function createToolsEffectiveHandlers(dependencies = defaultToolsEffectiveDependencies) {
\treturn {
\t\t"tools.effective": async ({ params, respond, context }) => {
\t\t\tawait handleToolsEffectiveRequest({
\t\t\t\trawParams: params,
\t\t\t\trespond,
\t\t\t\tcontext,
\t\t\t\tdependencies
\t\t\t});
\t\t},
\t\t"mcpServerStatus/list": async ({ params, respond }) => {
\t\t\tawait handleMcpServerStatusListRequest({
\t\t\t\trawParams: params,
\t\t\t\trespond,
\t\t\t\tdependencies
\t\t\t});
\t\t},
\t\t"mcpSessionServers/update": async ({ params, respond }) => {
\t\t\tawait handleMcpSessionServersUpdateRequest({
\t\t\t\trawParams: params,
\t\t\t\trespond,
\t\t\t\tdependencies
\t\t\t});
\t\t}
\t};
}`;
  const handlersPatch = replaceOptionalOnce(source, handlersNeedle, handlersReplacement, patchId);
  source = handlersPatch.source;
  changed ||= handlersPatch.changed;

  const existingHandlersNeedle = `\t\t"mcpServerStatus/list": async ({ params, respond }) => {
\t\t\tawait handleMcpServerStatusListRequest({
\t\t\t\trawParams: params,
\t\t\t\trespond,
\t\t\t\tdependencies
\t\t\t});
\t\t}
\t};`;
  const existingHandlersReplacement = `\t\t"mcpServerStatus/list": async ({ params, respond }) => {
\t\t\tawait handleMcpServerStatusListRequest({
\t\t\t\trawParams: params,
\t\t\t\trespond,
\t\t\t\tdependencies
\t\t\t});
\t\t},
\t\t"mcpSessionServers/update": async ({ params, respond }) => {
\t\t\tawait handleMcpSessionServersUpdateRequest({
\t\t\t\trawParams: params,
\t\t\t\trespond,
\t\t\t\tdependencies
\t\t\t});
\t\t}
\t};`;
  const existingHandlersPatch = replaceOptionalOnce(source, existingHandlersNeedle, existingHandlersReplacement, patchId);
  source = existingHandlersPatch.source;
  changed ||= existingHandlersPatch.changed;

  if (changed) writeText(filePath, source);
  return changed;
}

function patchProviderConfigDebugTrace(openclawDir) {
  const patchId = 'provider-config-debug-trace';
  const distDir = path.join(openclawDir, 'dist');
  const reloadFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'server-reload-managed-',
    markers: [
      'function startGatewayConfigReloader(opts)',
      'function createGatewayActiveWorkTracker(options)',
      'function createGatewayReloadHandlers(params)',
      'config reload failed: ${String(err)}',
    ],
  });
  const runtimeReloadFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'server-start-',
    markers: [
      'const reloadAttachedGatewayPlugins = async (params) => {',
      'const nextPluginLookUpTable = loadPluginLookUpTable({',
      'await params.commitRuntime(() => {',
      'const nextServices = await startPluginServices({',
    ],
  });
  const configMethodsFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'config-',
    markers: [
      'async function respondWithConfigRestartWrite(params)',
      'const changedPaths = diffGatewayReloadPaths(snapshot.config, validatedConfig, listConfigReloadRefinementPrefixes());',
      'context?.logGateway?.info(`config.patch write',
    ],
  });
  const servicesFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'services-',
    markers: [
      'async function startPluginServices(params)',
      'const stopService = async (entry, failures, deadline, beforeStop) => {',
      'plugin service replacement cleanup failed',
    ],
  });
  const taskMaintenanceFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'task-registry.maintenance-',
    markers: [
      'function findTaskSessionEntry(task, context)',
      'function getInspectableActiveTaskRestartBlockers()',
      'taskRegistryMaintenanceRuntime.resolveStorePath(void 0, { agentId })',
    ],
  });
  const pathsFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'paths-',
    markers: [
      'var SessionStoreAgentIdRequiredError = class extends Error',
      'function resolveSessionStorePathCore(store, opts)',
    ],
  });
  const changed = [
    [reloadFile, patchProviderConfigReloadTrace(reloadFile, patchId)],
    [runtimeReloadFile, patchProviderConfigRuntimeReloadTrace(runtimeReloadFile, patchId)],
    [configMethodsFile, patchProviderConfigMethodsTrace(configMethodsFile, patchId)],
    [servicesFile, patchProviderConfigServicesTrace(servicesFile, patchId)],
    [taskMaintenanceFile, patchProviderConfigTaskTrace(taskMaintenanceFile, patchId)],
    [pathsFile, patchProviderConfigSessionPathTrace(pathsFile, patchId)],
  ].filter(([, changed]) => changed).map(([file]) => path.basename(file));
  return changed.length > 0
    ? { status: 'applied', detail: changed.join(', ') }
    : { status: 'clean', detail: 'already patched' };
}

function patchProviderConfigReloadTrace(filePath, patchId) {
  let source = readText(filePath);
  let changed = false;
  const helper = [
    'function matchaProviderDebugTrace(source, phase, details = {}) {',
    '\tconst suffix = Object.entries(details).filter(([, value]) => value !== void 0).map(([key, value]) => `${key}=${String(value)}`).join(" ");',
    '\tconsole.warn(`[startup-trace] source=${source} phase=${phase}${suffix ? " detail=" + suffix : ""}`);',
    '}',
    'function matchaProviderDebugError(error) {',
    '\treturn {',
    '\t\terror_name: error instanceof Error ? error.name : typeof error,',
    '\t\tmessage_len: error instanceof Error ? error.message.length : String(error).length',
    '\t};',
    '}',
  ].join('\n');
  const helperNeedle = `const WATCHER_RECREATE_BACKOFF_MS = [
\t500,
\t2e3,
\t5e3
];`;
  let helperPatch = replaceOptionalOnce(source, helperNeedle, `${helperNeedle}\n${helper}`, patchId);
  if (!helperPatch.changed && !source.includes('function matchaProviderDebugTrace(')) {
    helperPatch = replaceOptionalOnce(source, 'const WATCHER_RECREATE_MAX_RETRIES = 3;', `const WATCHER_RECREATE_MAX_RETRIES = 3;\n${helper}`, patchId);
  }
  source = helperPatch.source;
  changed ||= helperPatch.changed;

  const planNeedle = `\t\t\tconst plan = buildGatewayReloadPlan(changedPaths, {
\t\t\t\tnoopPaths: pluginInstallTimestampNoopPaths,
\t\t\t\tforceChangedPaths: pluginInstallWholeRecordPaths,
\t\t\t\tcandidateConfig: nextConfig,
\t\t\t\tcandidateCompareConfig: nextCompareConfig,
\t\t\t\tpreviousCompareConfig: currentCompareConfig,
\t\t\t\tpreviousConfig: currentConfig
\t\t\t});`;
  const planReplacement = `${planNeedle}
\t\t\tmatchaProviderDebugTrace("openclaw-config-reload", "plan", {
\t\t\t\tchanged_paths: changedPaths.length,
\t\t\t\tnoop_paths: pluginInstallTimestampNoopPaths.length,
\t\t\t\tplugin_whole_record_paths: pluginInstallWholeRecordPaths.length,
\t\t\t\treload_plugins: Boolean(plan.reloadPlugins),
\t\t\t\trestart_gateway: Boolean(plan.restartGateway),
\t\t\t\trestart_channels: plan.restartChannels?.size ?? 0,
\t\t\t\trestart_channel_accounts: plan.restartChannelAccounts?.size ?? 0,
\t\t\t\tdispose_mcp_runtimes: Boolean(plan.disposeMcpRuntimes),
\t\t\t\thot_reasons: plan.hotReasons?.length ?? 0,
\t\t\t\trestart_reasons: plan.restartReasons?.length ?? 0
\t\t\t});`;
  const planPatch = replaceOptionalOnce(source, planNeedle, planReplacement, patchId);
  source = planPatch.source;
  changed ||= planPatch.changed;

  const writeNeedle = `\t\t\tlastAppliedWriteHash = event.persistedHash;
\t\t\tscheduleAfter(0);`;
  const writeReplacement = `\t\t\tlastAppliedWriteHash = event.persistedHash;
\t\t\tmatchaProviderDebugTrace("openclaw-config-reload", "write-observed", {
\t\t\t\tafter_write: event.afterWrite?.mode ?? "none",
\t\t\t\tpersisted_hash_present: typeof event.persistedHash === "string",
\t\t\t\tapplication: Boolean(application),
\t\t\t\tpending_in_process: Boolean(pendingInProcessConfig)
\t\t\t});
\t\t\tscheduleAfter(0);`;
  const writePatch = replaceOptionalOnce(source, writeNeedle, writeReplacement, patchId);
  source = writePatch.source;
  changed ||= writePatch.changed;

  const failureNeedle = `\t\t\t} catch (err) {
\t\t\t\tconst superseded = err instanceof GatewayConfigReloadSupersededError;
\t\t\t\tif (!(superseded && attemptedCandidate !== null && watcherIntentCandidate === attemptedCandidate)) settleApplication(attemptedCandidate, superseded ? "superseded" : "failed");
\t\t\t\tif (superseded) opts.log.info(\`config reload superseded: \${String(err)}\`);
\t\t\t\telse opts.log.error(\`config reload failed: \${String(err)}\`);
\t\t\t} finally {`;
  const failureReplacement = `\t\t\t} catch (err) {
\t\t\t\tconst superseded = err instanceof GatewayConfigReloadSupersededError;
\t\t\t\tif (!(superseded && attemptedCandidate !== null && watcherIntentCandidate === attemptedCandidate)) settleApplication(attemptedCandidate, superseded ? "superseded" : "failed");
\t\t\t\tmatchaProviderDebugTrace("openclaw-config-reload", superseded ? "superseded" : "failed", {
\t\t\t\t\tcandidate: attemptedCandidate !== null,
\t\t\t\t\tpending_in_process: Boolean(pendingInProcessConfig),
\t\t\t\t\twatcher_intent: Boolean(watcherIntentCandidate),
\t\t\t\t\t...matchaProviderDebugError(err)
\t\t\t\t});
\t\t\t\tif (superseded) opts.log.info(\`config reload superseded: \${String(err)}\`);
\t\t\t\telse opts.log.error(\`config reload failed: \${String(err)}\`);
\t\t\t} finally {`;
  const failurePatch = replaceOptionalOnce(source, failureNeedle, failureReplacement, patchId);
  source = failurePatch.source;
  changed ||= failurePatch.changed;

  const activeCountsNeedle = `\t\tconst getActiveCounts = () => {
\t\t\tconst queueSize = getTotalQueueSize();
\t\t\tconst pendingReplies = getTotalPendingReplies();
\t\t\tconst embeddedRuns = getActiveEmbeddedRunCount();
\t\t\tconst backgroundExecSessions = getActiveBackgroundExecSessionCount();
\t\t\tconst rootRequests = getActiveGatewayRootWorkCount({ excludeCurrent: true });
\t\t\tconst activeTasks = getInspectableActiveTaskRestartBlockers().length;
\t\t\treturn {
\t\t\t\tqueueSize,
\t\t\t\tpendingReplies,
\t\t\t\tembeddedRuns,
\t\t\t\tbackgroundExecSessions,
\t\t\t\trootRequests,
\t\t\t\tactiveTasks,
\t\t\t\ttotalActive: queueSize + pendingReplies + embeddedRuns + backgroundExecSessions + rootRequests + activeTasks
\t\t\t};
\t\t};`;
  const activeCountsReplacement = `\t\tconst getActiveCounts = () => {
\t\t\tconst queueSize = getTotalQueueSize();
\t\t\tconst pendingReplies = getTotalPendingReplies();
\t\t\tconst embeddedRuns = getActiveEmbeddedRunCount();
\t\t\tconst backgroundExecSessions = getActiveBackgroundExecSessionCount();
\t\t\tconst rootRequests = getActiveGatewayRootWorkCount({ excludeCurrent: true });
\t\t\tlet activeTasks = 0;
\t\t\ttry {
\t\t\t\tactiveTasks = getInspectableActiveTaskRestartBlockers().length;
\t\t\t} catch (err) {
\t\t\t\tmatchaProviderDebugTrace("openclaw-active-work", "task-blockers-failed", matchaProviderDebugError(err));
\t\t\t\tthrow err;
\t\t\t}
\t\t\tconst totalActive = queueSize + pendingReplies + embeddedRuns + backgroundExecSessions + rootRequests + activeTasks;
\t\t\tif (totalActive > 0) matchaProviderDebugTrace("openclaw-active-work", "counts", {
\t\t\t\tqueue_size: queueSize,
\t\t\t\tpending_replies: pendingReplies,
\t\t\t\tembedded_runs: embeddedRuns,
\t\t\t\tbackground_exec_sessions: backgroundExecSessions,
\t\t\t\troot_requests: rootRequests,
\t\t\t\tactive_tasks: activeTasks,
\t\t\t\ttotal_active: totalActive
\t\t\t});
\t\t\treturn {
\t\t\t\tqueueSize,
\t\t\t\tpendingReplies,
\t\t\t\tembeddedRuns,
\t\t\t\tbackgroundExecSessions,
\t\t\t\trootRequests,
\t\t\t\tactiveTasks,
\t\t\t\ttotalActive
\t\t\t};
\t\t};`;
  const activeCountsPatch = replaceOptionalOnce(source, activeCountsNeedle, activeCountsReplacement, patchId);
  source = activeCountsPatch.source;
  changed ||= activeCountsPatch.changed;

  const taskBlockersNeedle = `\t\tconst formatTaskBlockers = () => {
\t\t\tconst blockers = getInspectableActiveTaskRestartBlockers();
\t\t\tif (blockers.length === 0) return null;`;
  const taskBlockersReplacement = `\t\tconst formatTaskBlockers = () => {
\t\t\tlet blockers;
\t\t\ttry {
\t\t\t\tblockers = getInspectableActiveTaskRestartBlockers();
\t\t\t} catch (err) {
\t\t\t\tmatchaProviderDebugTrace("openclaw-active-work", "task-blockers-format-failed", matchaProviderDebugError(err));
\t\t\t\tthrow err;
\t\t\t}
\t\t\tif (blockers.length === 0) return null;`;
  const taskBlockersPatch = replaceOptionalOnce(source, taskBlockersNeedle, taskBlockersReplacement, patchId);
  source = taskBlockersPatch.source;
  changed ||= taskBlockersPatch.changed;

  const channelCheckNeedle = `\t\t\tconst initial = getActiveCounts();
\t\t\tif (initial.totalActive <= 0) return false;
\t\t\tconst channelIds = [...new Set(channels)];`;
  const channelCheckReplacement = `\t\t\tconst initial = getActiveCounts();
\t\t\tconst channelIds = [...new Set(channels)];
\t\t\tmatchaProviderDebugTrace("openclaw-active-work", "channel-reload-check", {
\t\t\t\tchannels: channelIds.length,
\t\t\t\tpublication_pending: Boolean(publicationPending),
\t\t\t\ttotal_active: initial.totalActive,
\t\t\t\tactive_tasks: initial.activeTasks
\t\t\t});
\t\t\tif (initial.totalActive <= 0) return false;`;
  const channelCheckPatch = replaceOptionalOnce(source, channelCheckNeedle, channelCheckReplacement, patchId);
  source = channelCheckPatch.source;
  changed ||= channelCheckPatch.changed;

  const hotStartNeedle = `\t\tconst applyHotReload = async (plan, nextConfig, publication) => {
\t\t\tassertIrreversibleReloadPlanHasRecoveryOwner(plan, restartRecoveryAvailable);`;
  const hotStartReplacement = `\t\tconst applyHotReload = async (plan, nextConfig, publication) => {
\t\t\tmatchaProviderDebugTrace("openclaw-hot-reload", "start", {
\t\t\t\tchanged_paths: plan.changedPaths?.length ?? 0,
\t\t\t\treload_plugins: Boolean(plan.reloadPlugins),
\t\t\t\trestart_gateway: Boolean(plan.restartGateway),
\t\t\t\trestart_channels: plan.restartChannels?.size ?? 0,
\t\t\t\trestart_channel_accounts: plan.restartChannelAccounts?.size ?? 0,
\t\t\t\tdispose_mcp_runtimes: Boolean(plan.disposeMcpRuntimes)
\t\t\t});
\t\t\tassertIrreversibleReloadPlanHasRecoveryOwner(plan, restartRecoveryAvailable);`;
  const hotStartPatch = replaceOptionalOnce(source, hotStartNeedle, hotStartReplacement, patchId);
  source = hotStartPatch.source;
  changed ||= hotStartPatch.changed;

  const recoveryNeedle = `\t\t\tconst scheduleRecoveryRestart = (surface, err) => {
\t\t\t\tconst detail = err === void 0 ? "" : \`: \${formatErrorMessage(err)}\`;`;
  const recoveryReplacement = `\t\t\tconst scheduleRecoveryRestart = (surface, err) => {
\t\t\t\tmatchaProviderDebugTrace("openclaw-hot-reload", "recovery-restart", {
\t\t\t\t\tsurface_len: String(surface).length,
\t\t\t\t\truntime_committed: runtimeCommitted,
\t\t\t\t\trecovery_available: restartRecoveryAvailable,
\t\t\t\t\t...matchaProviderDebugError(err)
\t\t\t\t});
\t\t\t\tconst detail = err === void 0 ? "" : \`: \${formatErrorMessage(err)}\`;`;
  const recoveryPatch = replaceOptionalOnce(source, recoveryNeedle, recoveryReplacement, patchId);
  source = recoveryPatch.source;
  changed ||= recoveryPatch.changed;

  if (changed) writeText(filePath, source);
  return changed;
}

function patchProviderConfigMethodsTrace(filePath, patchId) {
  let source = readText(filePath);
  let changed = false;
  const helper = [
    'function matchaConfigMethodTrace(phase, details = {}) {',
    '\tconst suffix = Object.entries(details).filter(([, value]) => value !== void 0).map(([key, value]) => `${key}=${String(value)}`).join(" ");',
    '\tconsole.warn(`[startup-trace] source=openclaw-config-method phase=${phase}${suffix ? " detail=" + suffix : ""}`);',
    '}',
    'function matchaConfigPatchTopKeys(value) {',
    '\treturn value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).join(",") : "";',
    '}',
  ].join('\n');
  const helperNeedle = 'function clearConfigSchemaResponseCache() {';
  const helperPatch = replaceOptionalOnce(source, helperNeedle, `${helper}\n${helperNeedle}`, patchId);
  source = helperPatch.source;
  changed ||= helperPatch.changed;

  const applicationNeedle = `\tif (params.writeResult.application) {
\t\tconst outcome = await params.writeResult.application;
\t\tif (outcome !== "applied") {`;
  const applicationReplacement = `\tif (params.writeResult.application) {
\t\tmatchaConfigMethodTrace("application-wait", {
\t\t\tmode: params.mode,
\t\t\tchanged_paths: params.changedPaths?.length ?? 0
\t\t});
\t\tconst outcome = await params.writeResult.application;
\t\tmatchaConfigMethodTrace("application-outcome", {
\t\t\tmode: params.mode,
\t\t\toutcome,
\t\t\tchanged_paths: params.changedPaths?.length ?? 0
\t\t});
\t\tif (outcome !== "applied") {`;
  const applicationPatch = replaceOptionalOnce(source, applicationNeedle, applicationReplacement, patchId);
  source = applicationPatch.source;
  changed ||= applicationPatch.changed;

  const patchNeedle = `\t\tconst changedPaths = diffGatewayReloadPaths(snapshot.config, validatedConfig, listConfigReloadRefinementPrefixes());
\t\tcontext?.logGateway?.info(\`config.patch write \${formatControlPlaneActor(actor)} changedPaths=\${summarizeChangedPaths(changedPaths)} restartReason=config.patch\`);`;
  const patchReplacement = `\t\tconst changedPaths = diffGatewayReloadPaths(snapshot.config, validatedConfig, listConfigReloadRefinementPrefixes());
\t\tmatchaConfigMethodTrace("patch-ready", {
\t\t\ttop_keys: matchaConfigPatchTopKeys(normalizedPatch),
\t\t\treplace_paths: replacePaths.length,
\t\t\tchanged_paths: changedPaths.length,
\t\t\tawait_runtime: shouldAwaitGatewayConfigApplication({
\t\t\t\tchangedPaths,
\t\t\t\tpreviousConfig: snapshot.config,
\t\t\t\tnextConfig: validatedConfig
\t\t\t})
\t\t});
\t\tcontext?.logGateway?.info(\`config.patch write \${formatControlPlaneActor(actor)} changedPaths=\${summarizeChangedPaths(changedPaths)} restartReason=config.patch\`);`;
  const patchPatch = replaceOptionalOnce(source, patchNeedle, patchReplacement, patchId);
  source = patchPatch.source;
  changed ||= patchPatch.changed;

  if (changed) writeText(filePath, source);
  return changed;
}

function patchProviderConfigRuntimeReloadTrace(filePath, patchId) {
  let source = readText(filePath);
  let changed = false;
  const helper = [
    'function matchaProviderRuntimeReloadTrace(phase, details = {}) {',
    '\tconst suffix = Object.entries(details).filter(([, value]) => value !== void 0).map(([key, value]) => `${key}=${String(value)}`).join(" ");',
    '\tconsole.warn(`[startup-trace] source=openclaw-plugin-runtime-reload phase=${phase}${suffix ? " detail=" + suffix : ""}`);',
    '}',
    'function matchaProviderRuntimeReloadError(error) {',
    '\treturn {',
    '\t\terror_name: error instanceof Error ? error.name : typeof error,',
    '\t\tmessage_len: error instanceof Error ? error.message.length : String(error).length',
    '\t};',
    '}',
  ].join('\n');
  const helperNeedle = 'import "./sessions-dovo0Bf5.mjs";';
  const helperPatch = replaceOptionalOnce(source, helperNeedle, `${helperNeedle}\n${helper}`, patchId);
  source = helperPatch.source;
  changed ||= helperPatch.changed;

  const startNeedle = `\tconst reloadAttachedGatewayPlugins = async (params) => {
\t\tconst [{ loadPluginLookUpTable }, { listAmbientOnlyConfiguredChannelIds }, { prepareGatewayPluginLoad }, { startPluginServices, PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS }] = await Promise.all([`;
  const startReplacement = `\tconst reloadAttachedGatewayPlugins = async (params) => {
\t\tmatchaProviderRuntimeReloadTrace("start", {
\t\t\tnext_has_plugins: Boolean(params.nextConfig?.plugins),
\t\t\tsource_has_plugins: Boolean(params.sourceConfig?.plugins)
\t\t});
\t\tconst [{ loadPluginLookUpTable }, { listAmbientOnlyConfiguredChannelIds }, { prepareGatewayPluginLoad }, { startPluginServices, PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS }] = await Promise.all([`;
  const startPatch = replaceOptionalOnce(source, startNeedle, startReplacement, patchId);
  source = startPatch.source;
  changed ||= startPatch.changed;

  const lookupNeedle = `\t\tconst nextAmbientAutostartSuppressedChannelIds = ambientEnvTriggers === "suppress" ? new Set(listAmbientOnlyConfiguredChannelIds({`;
  const lookupReplacement = `\t\tmatchaProviderRuntimeReloadTrace("lookup-loaded", {
\t\t\tplugins: nextPluginLookUpTable?.pluginIds?.size ?? nextPluginLookUpTable?.pluginIds?.length ?? 0,
\t\t\tmanifests: nextPluginLookUpTable?.manifestRegistry?.plugins?.size ?? nextPluginLookUpTable?.manifestRegistry?.plugins?.length ?? 0
\t\t});
\t\tconst nextAmbientAutostartSuppressedChannelIds = ambientEnvTriggers === "suppress" ? new Set(listAmbientOnlyConfiguredChannelIds({`;
  const lookupPatch = replaceOptionalOnce(source, lookupNeedle, lookupReplacement, patchId);
  source = lookupPatch.source;
  changed ||= lookupPatch.changed;

  const beforeNeedle = `\t\ttry {
\t\t\tawait params.beforeReplace(beforeChannelIds);`;
  const beforeReplacement = `\t\ttry {
\t\t\tmatchaProviderRuntimeReloadTrace("before-replace", { channels: beforeChannelIds.size });
\t\t\tawait params.beforeReplace(beforeChannelIds);`;
  const beforePatch = replaceOptionalOnce(source, beforeNeedle, beforeReplacement, patchId);
  source = beforePatch.source;
  changed ||= beforePatch.changed;

  const stopNeedle = `\t\t\t\tawait previousServices.stop({
\t\t\t\t\tstrict: true,
\t\t\t\t\tdeadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS
\t\t\t\t});`;
  const stopReplacement = `\t\t\t\tmatchaProviderRuntimeReloadTrace("previous-services-stop", {});
\t\t\t\tawait previousServices.stop({
\t\t\t\t\tstrict: true,
\t\t\t\t\tdeadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS
\t\t\t\t});
\t\t\t\tmatchaProviderRuntimeReloadTrace("previous-services-stopped", {});`;
  const stopPatch = replaceOptionalOnce(source, stopNeedle, stopReplacement, patchId);
  source = stopPatch.source;
  changed ||= stopPatch.changed;

  const commitNeedle = `\t\t\tawait params.commitRuntime(() => {`;
  const commitReplacement = `\t\t\tmatchaProviderRuntimeReloadTrace("commit-runtime-start", {});
\t\t\tawait params.commitRuntime(() => {`;
  const commitPatch = replaceOptionalOnce(source, commitNeedle, commitReplacement, patchId);
  source = commitPatch.source;
  changed ||= commitPatch.changed;

  const publishNeedle = `\t\t\tif (!replacement.claim.publish(() => {`;
  const publishReplacement = `\t\t\tmatchaProviderRuntimeReloadTrace("publish-start", {});
\t\t\tif (!replacement.claim.publish(() => {`;
  const publishPatch = replaceOptionalOnce(source, publishNeedle, publishReplacement, patchId);
  source = publishPatch.source;
  changed ||= publishPatch.changed;

  const loadNeedle = `\t\t\t\tloaded = prepareGatewayPluginLoad({`;
  const loadReplacement = `\t\t\t\tmatchaProviderRuntimeReloadTrace("prepare-load-start", {});
\t\t\t\tloaded = prepareGatewayPluginLoad({`;
  const loadPatch = replaceOptionalOnce(source, loadNeedle, loadReplacement, patchId);
  source = loadPatch.source;
  changed ||= loadPatch.changed;

  const replaceNeedle = `\t\t\t\treplaceAttachedPluginRuntime(loaded);
\t\t\t\treleaseChannelStarts("published");`;
  const replaceReplacement = `\t\t\t\tmatchaProviderRuntimeReloadTrace("prepare-load-finished", {});
\t\t\t\treplaceAttachedPluginRuntime(loaded);
\t\t\t\tmatchaProviderRuntimeReloadTrace("runtime-replaced", {});
\t\t\t\treleaseChannelStarts("published");`;
  const replacePatch = replaceOptionalOnce(source, replaceNeedle, replaceReplacement, patchId);
  source = replacePatch.source;
  changed ||= replacePatch.changed;

  const discoveryNeedle = `\t\t\tawait refreshAttachedGatewayDiscovery(loaded.pluginRegistry, replacement.claim);`;
  const discoveryReplacement = `\t\t\tmatchaProviderRuntimeReloadTrace("discovery-refresh-start", {});
\t\t\tawait refreshAttachedGatewayDiscovery(loaded.pluginRegistry, replacement.claim);
\t\t\tmatchaProviderRuntimeReloadTrace("discovery-refresh-finished", {});`;
  const discoveryPatch = replaceOptionalOnce(source, discoveryNeedle, discoveryReplacement, patchId);
  source = discoveryPatch.source;
  changed ||= discoveryPatch.changed;

  const servicesNeedle = `\t\t\tconst nextServices = await startPluginServices({`;
  const servicesReplacement = `\t\t\tmatchaProviderRuntimeReloadTrace("services-start", {});
\t\t\tconst nextServices = await startPluginServices({`;
  const servicesPatch = replaceOptionalOnce(source, servicesNeedle, servicesReplacement, patchId);
  source = servicesPatch.source;
  changed ||= servicesPatch.changed;

  const servicesDoneNeedle = `\t\t\tif (!await replacement.claim.waitForUnblocked() || !pluginRuntimeGeneration.publishServices(replacement.claim, nextServices)) await nextServices.stop({`;
  const servicesDoneReplacement = `\t\t\tmatchaProviderRuntimeReloadTrace("services-started", {});
\t\t\tif (!await replacement.claim.waitForUnblocked() || !pluginRuntimeGeneration.publishServices(replacement.claim, nextServices)) await nextServices.stop({`;
  const servicesDonePatch = replaceOptionalOnce(source, servicesDoneNeedle, servicesDoneReplacement, patchId);
  source = servicesDonePatch.source;
  changed ||= servicesDonePatch.changed;

  const catchNeedle = `\t\t} catch (error) {
\t\t\treplacement.reject();
\t\t\trecoverFromReplacementTeardown?.(error);
\t\t\tthrow error;
\t\t} finally {`;
  const catchReplacement = `\t\t} catch (error) {
\t\t\tmatchaProviderRuntimeReloadTrace("failed", matchaProviderRuntimeReloadError(error));
\t\t\treplacement.reject();
\t\t\trecoverFromReplacementTeardown?.(error);
\t\t\tthrow error;
\t\t} finally {`;
  const catchPatch = replaceOptionalOnce(source, catchNeedle, catchReplacement, patchId);
  source = catchPatch.source;
  changed ||= catchPatch.changed;

  const doneNeedle = `\t\treturn { activeChannels: listAttachedChannelIds() };`;
  const doneReplacement = `\t\tconst activeChannels = listAttachedChannelIds();
\t\tmatchaProviderRuntimeReloadTrace("finished", { channels: activeChannels.size });
\t\treturn { activeChannels };`;
  const donePatch = replaceOptionalOnce(source, doneNeedle, doneReplacement, patchId);
  source = donePatch.source;
  changed ||= donePatch.changed;

  if (changed) writeText(filePath, source);
  return changed;
}

function patchProviderConfigServicesTrace(filePath, patchId) {
  let source = readText(filePath);
  let changed = false;
  const helper = [
    'function matchaPluginServiceTrace(phase, details = {}) {',
    '\tconst suffix = Object.entries(details).filter(([, value]) => value !== void 0).map(([key, value]) => `${key}=${String(value)}`).join(" ");',
    '\tconsole.warn(`[startup-trace] source=openclaw-plugin-services phase=${phase}${suffix ? " detail=" + suffix : ""}`);',
    '}',
    'function matchaPluginServiceError(error) {',
    '\treturn {',
    '\t\terror_name: error instanceof Error ? error.name : typeof error,',
    '\t\tmessage_len: error instanceof Error ? error.message.length : String(error).length',
    '\t};',
    '}',
  ].join('\n');
  const helperNeedle = 'async function startPluginServices(params) {';
  const helperPatch = replaceOptionalOnce(source, helperNeedle, `${helper}\n${helperNeedle}`, patchId);
  source = helperPatch.source;
  changed ||= helperPatch.changed;

  const stopNeedle = `\tconst stopService = async (entry, failures, deadline, beforeStop) => {
\t\tentry.stopping = true;
\t\ttry {`;
  const stopReplacement = `\tconst stopService = async (entry, failures, deadline, beforeStop) => {
\t\tentry.stopping = true;
\t\tmatchaPluginServiceTrace("stop-start", {
\t\t\tplugin_id: entry.pluginId,
\t\t\tservice_id: entry.id,
\t\t\thas_deadline: deadline !== void 0,
\t\t\tstartup_pending: Boolean(entry.startup)
\t\t});
\t\ttry {`;
  const stopPatch = replaceOptionalOnce(source, stopNeedle, stopReplacement, patchId);
  source = stopPatch.source;
  changed ||= stopPatch.changed;

  const stopDoneNeedle = `\t\tawait runBeforeDeadline(cleanup, deadline, entry.startup ? "plugin service startup settlement" : "plugin service stop");`;
  const stopDoneReplacement = `${stopDoneNeedle}
\t\tmatchaPluginServiceTrace("stop-done", {
\t\t\tplugin_id: entry.pluginId,
\t\t\tservice_id: entry.id
\t\t});`;
  const stopDonePatch = replaceOptionalOnce(source, stopDoneNeedle, stopDoneReplacement, patchId);
  source = stopDonePatch.source;
  changed ||= stopDonePatch.changed;

  const stopFailedNeedle = `\t} catch (err) {
\t\tlog.warn(\`plugin service stop failed (\${entry.id}): \${String(err)}\`);`;
  const stopFailedReplacement = `\t} catch (err) {
\t\tmatchaPluginServiceTrace("stop-failed", {
\t\t\tplugin_id: entry.pluginId,
\t\t\tservice_id: entry.id,
\t\t\t...matchaPluginServiceError(err)
\t\t});
\t\tlog.warn(\`plugin service stop failed (\${entry.id}): \${String(err)}\`);`;
  const stopFailedPatch = replaceOptionalOnce(source, stopFailedNeedle, stopFailedReplacement, patchId);
  source = stopFailedPatch.source;
  changed ||= stopFailedPatch.changed;

  const handleStopNeedle = `\tstop: (options) => {
\t\tstopRequested = true;
\t\tconst strict = options?.strict === true;
\t\tconst deadline = strict ? options.deadlineAtMs : void 0;`;
  const handleStopReplacement = `\tstop: (options) => {
\t\tstopRequested = true;
\t\tconst strict = options?.strict === true;
\t\tconst deadline = strict ? options.deadlineAtMs : void 0;
\t\tmatchaPluginServiceTrace("handle-stop", {
\t\t\tstrict,
\t\t\tservice_count: ownedServices.length,
\t\t\thas_deadline: deadline !== void 0
\t\t});`;
  const handleStopPatch = replaceOptionalOnce(source, handleStopNeedle, handleStopReplacement, patchId);
  source = handleStopPatch.source;
  changed ||= handleStopPatch.changed;

  const aggregateNeedle = `\t\tif (failures.length > 0) throw new AggregateError(failures, strict ? "plugin service replacement cleanup failed" : "multiple diagnostics exporters failed to stop");`;
  const aggregateReplacement = `\t\tif (failures.length > 0) {
\t\t\tmatchaPluginServiceTrace("handle-stop-failed", {
\t\t\t\tstrict,
\t\t\t\tfailures: failures.length
\t\t\t});
\t\t\tthrow new AggregateError(failures, strict ? "plugin service replacement cleanup failed" : "multiple diagnostics exporters failed to stop");
\t\t}`;
  const aggregatePatch = replaceOptionalOnce(source, aggregateNeedle, aggregateReplacement, patchId);
  source = aggregatePatch.source;
  changed ||= aggregatePatch.changed;

  const startNeedle = `\tconst startService = async (entry, config, strict = false, index = ownedServices.length) => {
\t\tconst service = entry.service;`;
  const startReplacement = `\tconst startService = async (entry, config, strict = false, index = ownedServices.length) => {
\t\tconst service = entry.service;
\t\tmatchaPluginServiceTrace("start-service", {
\t\t\tplugin_id: entry.pluginId,
\t\t\tservice_id: service.id,
\t\t\tstrict
\t\t});`;
  const startPatch = replaceOptionalOnce(source, startNeedle, startReplacement, patchId);
  source = startPatch.source;
  changed ||= startPatch.changed;

  const startDoneNeedle = `\t\tawait (params.startupTrace ? params.startupTrace.measure(traceName, invokeStart) : invokeStart());
\t\treturn true;`;
  const startDoneReplacement = `\t\tawait (params.startupTrace ? params.startupTrace.measure(traceName, invokeStart) : invokeStart());
\t\tmatchaPluginServiceTrace("start-service-done", {
\t\t\tplugin_id: entry.pluginId,
\t\t\tservice_id: service.id
\t\t});
\t\treturn true;`;
  const startDonePatch = replaceOptionalOnce(source, startDoneNeedle, startDoneReplacement, patchId);
  source = startDonePatch.source;
  changed ||= startDonePatch.changed;

  const startFailedNeedle = `\t} catch (err) {
\t\tserviceContext.serviceHealth?.reportFailure(err);`;
  const startFailedReplacement = `\t} catch (err) {
\t\tmatchaPluginServiceTrace("start-service-failed", {
\t\t\tplugin_id: entry.pluginId,
\t\t\tservice_id: service.id,
\t\t\tstrict,
\t\t\t...matchaPluginServiceError(err)
\t\t});
\t\tserviceContext.serviceHealth?.reportFailure(err);`;
  const startFailedPatch = replaceOptionalOnce(source, startFailedNeedle, startFailedReplacement, patchId);
  source = startFailedPatch.source;
  changed ||= startFailedPatch.changed;

  if (changed) writeText(filePath, source);
  return changed;
}

function patchProviderConfigTaskTrace(filePath, patchId) {
  let source = readText(filePath);
  let changed = false;
  const helper = [
    'function matchaTaskDebugTrace(phase, details = {}) {',
    '\tconst suffix = Object.entries(details).filter(([, value]) => value !== void 0).map(([key, value]) => `${key}=${String(value)}`).join(" ");',
    '\tconsole.warn(`[startup-trace] source=task-registry-maintenance phase=${phase}${suffix ? " detail=" + suffix : ""}`);',
    '}',
    'function matchaTaskDebugError(error) {',
    '\treturn {',
    '\t\terror_name: error instanceof Error ? error.name : typeof error,',
    '\t\tmessage_len: error instanceof Error ? error.message.length : String(error).length',
    '\t};',
    '}',
    'function matchaTaskDebugLen(value) {',
    '\treturn typeof value === "string" ? value.length : 0;',
    '}',
  ].join('\n');
  const helperNeedle = 'const SWEEP_YIELD_BATCH_SIZE = 25;';
  const helperPatch = replaceOptionalOnce(source, helperNeedle, `${helperNeedle}\n${helper}`, patchId);
  source = helperPatch.source;
  changed ||= helperPatch.changed;

  const sessionNeedle = `function findTaskSessionEntry(task, context) {
\tconst childSessionKey = task.childSessionKey?.trim();
\tif (!childSessionKey) return;
\tconst agentId = taskRegistryMaintenanceRuntime.parseAgentSessionKey(childSessionKey)?.agentId;
\treturn findSessionEntryByKey(getSessionEntryLookup(taskRegistryMaintenanceRuntime.resolveStorePath(void 0, { agentId }), context), childSessionKey);
}`;
  const sessionReplacement = `function findTaskSessionEntry(task, context) {
\tconst childSessionKey = task.childSessionKey?.trim();
\tif (!childSessionKey) return;
\tconst agentId = taskRegistryMaintenanceRuntime.parseAgentSessionKey(childSessionKey)?.agentId;
\tmatchaTaskDebugTrace("session-entry.lookup", {
\t\ttask_id_len: matchaTaskDebugLen(task.taskId),
\t\truntime: task.runtime ?? "none",
\t\tchild_session_key_len: childSessionKey.length,
\t\tagent_id_present: Boolean(agentId?.trim()),
\t\tagent_id_len: matchaTaskDebugLen(agentId)
\t});
\tlet storePath;
\ttry {
\t\tstorePath = taskRegistryMaintenanceRuntime.resolveStorePath(void 0, { agentId });
\t} catch (error) {
\t\tmatchaTaskDebugTrace("session-entry.store-path-failed", {
\t\t\ttask_id_len: matchaTaskDebugLen(task.taskId),
\t\t\truntime: task.runtime ?? "none",
\t\t\tchild_session_key_len: childSessionKey.length,
\t\t\tagent_id_present: Boolean(agentId?.trim()),
\t\t\t...matchaTaskDebugError(error)
\t\t});
\t\tthrow error;
\t}
\ttry {
\t\treturn findSessionEntryByKey(getSessionEntryLookup(storePath, context), childSessionKey);
\t} catch (error) {
\t\tmatchaTaskDebugTrace("session-entry.lookup-failed", {
\t\t\ttask_id_len: matchaTaskDebugLen(task.taskId),
\t\t\truntime: task.runtime ?? "none",
\t\t\tchild_session_key_len: childSessionKey.length,
\t\t\tagent_id_present: Boolean(agentId?.trim()),
\t\t\t...matchaTaskDebugError(error)
\t\t});
\t\tthrow error;
\t}
}`;
  const sessionPatch = replaceOptionalOnce(source, sessionNeedle, sessionReplacement, patchId);
  source = sessionPatch.source;
  changed ||= sessionPatch.changed;

  const blockersNeedle = `function getInspectableActiveTaskRestartBlockers() {
\ttaskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
\tconst candidates = taskRegistryMaintenanceRuntime.listTaskRecords(isTaskRestartBlocker);
\tconst blockers = [];
\tfor (const task of reconcileTaskRecordsForOperatorInspection(candidates)) {
\t\tif (!isTaskRestartBlocker(task)) continue;
\t\tconst blocker = {
\t\t\ttaskId: task.taskId,
\t\t\tstatus: task.status,
\t\t\truntime: task.runtime
\t\t};
\t\tif (task.taskKind) blocker.taskKind = task.taskKind;
\t\tif (task.runId) blocker.runId = task.runId;
\t\tif (task.label) blocker.label = task.label;
\t\tif (task.task) blocker.title = task.task;
\t\tblockers.push(blocker);
\t}
\treturn blockers;
}`;
  const blockersReplacement = `function getInspectableActiveTaskRestartBlockers() {
\ttaskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
\tconst candidates = taskRegistryMaintenanceRuntime.listTaskRecords(isTaskRestartBlocker);
\tmatchaTaskDebugTrace("restart-blockers.candidates", { count: candidates.length });
\tlet reconciled;
\ttry {
\t\treconciled = reconcileTaskRecordsForOperatorInspection(candidates);
\t} catch (error) {
\t\tmatchaTaskDebugTrace("restart-blockers.reconcile-failed", {
\t\t\tcandidate_count: candidates.length,
\t\t\t...matchaTaskDebugError(error)
\t\t});
\t\tthrow error;
\t}
\tconst blockers = [];
\tfor (const task of reconciled) {
\t\tif (!isTaskRestartBlocker(task)) continue;
\t\tconst blocker = {
\t\t\ttaskId: task.taskId,
\t\t\tstatus: task.status,
\t\t\truntime: task.runtime
\t\t};
\t\tif (task.taskKind) blocker.taskKind = task.taskKind;
\t\tif (task.runId) blocker.runId = task.runId;
\t\tif (task.label) blocker.label = task.label;
\t\tif (task.task) blocker.title = task.task;
\t\tblockers.push(blocker);
\t}
\tmatchaTaskDebugTrace("restart-blockers.result", { count: blockers.length });
\treturn blockers;
}`;
  const blockersPatch = replaceOptionalOnce(source, blockersNeedle, blockersReplacement, patchId);
  source = blockersPatch.source;
  changed ||= blockersPatch.changed;

  if (changed) writeText(filePath, source);
  return changed;
}

function patchProviderConfigSessionPathTrace(filePath, patchId) {
  let source = readText(filePath);
  let changed = false;
  const helper = [
    'function matchaSessionPathTrace(phase, details = {}) {',
    '\tconst suffix = Object.entries(details).filter(([, value]) => value !== void 0).map(([key, value]) => `${key}=${String(value)}`).join(" ");',
    '\tconsole.warn(`[startup-trace] source=session-paths phase=${phase}${suffix ? " detail=" + suffix : ""}`);',
    '}',
  ].join('\n');
  const helperNeedle = `var SessionStoreAgentIdRequiredError = class extends Error {
\tconstructor() {
\t\tsuper("Session store path requires an explicit agent id.");
\t\tthis.name = "SessionStoreAgentIdRequiredError";
\t}
};`;
  const helperPatch = replaceOptionalOnce(source, helperNeedle, `${helperNeedle}\n${helper}`, patchId);
  source = helperPatch.source;
  changed ||= helperPatch.changed;

  const defaultNeedle = `\tif (!store) {
\t\tif (!opts?.agentId?.trim()) throw new SessionStoreAgentIdRequiredError();`;
  const defaultReplacement = `\tif (!store) {
\t\tif (!opts?.agentId?.trim()) {
\t\t\tmatchaSessionPathTrace("store-path.failed", {
\t\t\t\tstore_present: false,
\t\t\t\ttemplate: false,
\t\t\t\tagent_id_present: false
\t\t\t});
\t\t\tthrow new SessionStoreAgentIdRequiredError();
\t\t}`;
  const defaultPatch = replaceOptionalOnce(source, defaultNeedle, defaultReplacement, patchId);
  source = defaultPatch.source;
  changed ||= defaultPatch.changed;

  const templateNeedle = `\tif (store.includes("{agentId}")) {
\t\tif (!opts?.agentId?.trim()) throw new SessionStoreAgentIdRequiredError();`;
  const templateReplacement = `\tif (store.includes("{agentId}")) {
\t\tif (!opts?.agentId?.trim()) {
\t\t\tmatchaSessionPathTrace("store-path.failed", {
\t\t\t\tstore_present: true,
\t\t\t\ttemplate: true,
\t\t\t\tagent_id_present: false
\t\t\t});
\t\t\tthrow new SessionStoreAgentIdRequiredError();
\t\t}`;
  const templatePatch = replaceOptionalOnce(source, templateNeedle, templateReplacement, patchId);
  source = templatePatch.source;
  changed ||= templatePatch.changed;

  if (changed) writeText(filePath, source);
  return changed;
}

function patchExplicitSessionModelPatch(openclawDir) {
  const patchId = 'explicit-session-model-patch';
  const distDir = path.join(openclawDir, 'dist');
  const sessionsPatchFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'sessions-patch-',
    markers: [
      'function resolveSessionPatchModelSelection(params)',
      'if ("model" in patch) {',
      'applyModelOverrideWithAuthProfileCompatibility({',
      'markLiveSwitchPending: raw !== null',
    ],
  });
  return patchExplicitSessionModelSelection(sessionsPatchFile, patchId)
    ? { status: 'applied', detail: path.basename(sessionsPatchFile) }
    : { status: 'clean', detail: 'already patched' };
}

function patchExplicitSessionModelSelection(filePath, patchId) {
  let source = readText(filePath);
  if (source.includes('selection = { ...resolved, isDefault: false };')) return false;
  const pattern = /(\n[\t ]*if \(!resolved\.ok\) return invalid\(resolved\.error\);\n)([\t ]*)selection = resolved;/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`${patchId}: expected one session model patch selection target, found ${matches.length}`);
  }
  source = source.replace(pattern, '$1$2selection = { ...resolved, isDefault: false };');
  writeText(filePath, source);
  return true;
}

function patchAgentDeleteCleanupIdentityString(openclawDir) {
  const patchId = 'agent-delete-cleanup-identity-string';
  const distDir = path.join(openclawDir, 'dist');
  const agentsFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'agents-',
    markers: [
      'function cleanupPathIdentity(stat)',
      'async function prepareAgentDeleteCleanupPaths(',
      'cleanup path identity changed before deletion',
    ],
  });
  const journalFile = locateSingleJavaScriptFile(distDir, patchId, {
    fileNamePrefix: 'openclaw-agent-db-lease-',
    markers: [
      'function parseCleanupPaths(value)',
      'Invalid agent deletion cleanup path journal.',
      'function readAgentDeletionJournal(',
    ],
  });
  const changed = [
    [agentsFile, patchAgentDeleteCleanupIdentity(agentsFile, patchId)],
    [journalFile, patchAgentDeletionJournalCleanupIdentity(journalFile, patchId)],
  ].filter(([, changed]) => changed).map(([file]) => path.basename(file));
  return changed.length > 0
    ? { status: 'applied', detail: changed.join(', ') }
    : { status: 'clean', detail: 'already patched' };
}

function patchAgentDeleteCleanupIdentity(filePath, patchId) {
  let source = readText(filePath);
  const replacement = `function cleanupPathIdentity(stat) {
\tif (typeof stat?.dev !== "number" && typeof stat?.dev !== "bigint" || typeof stat.ino !== "number" && typeof stat.ino !== "bigint") return null;
\treturn {
\t\tdev: String(stat.dev),
\t\tino: String(stat.ino)
\t};
}
async function statAgentCleanupPath(cleanupPath) {`;
  const patch = replaceBlockOnce(
    source,
    'function cleanupPathIdentity(stat) {',
    '\nasync function statAgentCleanupPath(cleanupPath) {',
    replacement,
    patchId,
  );
  source = patch.source;
  if (patch.changed) writeText(filePath, source);
  return patch.changed;
}

function patchAgentDeletionJournalCleanupIdentity(filePath, patchId) {
  let source = readText(filePath);
  const replacement = `function parseCleanupPaths(value) {
\tconst parsed = JSON.parse(value);
\tif (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "object" && entry !== null && typeof entry.path === "string" && typeof entry.canonicalPath === "string" && typeof entry.parentPath === "string" && (entry.kind === "target" || entry.kind === "symlink") && (entry.dev === null || typeof entry.dev === "number" || typeof entry.dev === "string") && (entry.ino === null || typeof entry.ino === "number" || typeof entry.ino === "string") && typeof entry.coversDescendants === "boolean" && typeof entry.done === "boolean" && (entry.note === void 0 || typeof entry.note === "string") && Array.isArray(entry.sourcePaths) && entry.sourcePaths.every((sourcePath) => typeof sourcePath === "string"))) throw new Error("Invalid agent deletion cleanup path journal.");
\treturn parsed.map((entry) => ({
\t\t...entry,
\t\tdev: entry.dev === null ? null : String(entry.dev),
\t\tino: entry.ino === null ? null : String(entry.ino)
\t}));
}
function readAgentDeletionJournal(agentId, options = {}) {`;
  const patch = replaceBlockOnce(
    source,
    'function parseCleanupPaths(value) {',
    '\nfunction readAgentDeletionJournal(agentId, options = {}) {',
    replacement,
    patchId,
  );
  source = patch.source;
  if (patch.changed) writeText(filePath, source);
  return patch.changed;
}

const OPENCLAW_PATCHES = Object.freeze([
  {
    id: 'strip-bundled-channel-plugins',
    apply: stripBundledChannelPlugins,
  },
  {
    id: 'matcha-sealed-skills',
    apply: patchMatchaSealedSkills,
  },
  {
    id: 'opencode-go-session-header',
    apply: patchOpencodeGoSessionHeader,
  },
  {
    id: 'mcp-server-status-method',
    apply: patchMcpServerStatusMethod,
  },
  {
    id: 'provider-config-debug-trace',
    apply: patchProviderConfigDebugTrace,
  },
  {
    id: 'explicit-session-model-patch',
    apply: patchExplicitSessionModelPatch,
  },
  {
    id: 'agent-delete-cleanup-identity-string',
    apply: patchAgentDeleteCleanupIdentityString,
  },
]);

function selectOpenClawPatches(patchIds = DEFAULT_PATCH_IDS) {
  const requested = new Set(patchIds);
  const selected = OPENCLAW_PATCHES.filter((patch) => requested.has(patch.id));
  if (selected.length !== requested.size) {
    const known = new Set(OPENCLAW_PATCHES.map((patch) => patch.id));
    const unknown = [...requested].filter((id) => !known.has(id));
    throw new Error(`unknown OpenClaw patch id(s): ${unknown.join(', ')}`);
  }
  return selected;
}

export function applyOpenClawBundlePatches(openclawDir, options = {}) {
  const { allowMissing = false, log = printLine, patchIds } = options;
  if (!fs.existsSync(openclawDir)) {
    if (allowMissing) {
      log('ℹ️  openclaw 包未安装，跳过 OpenClaw bundle patches');
      return [];
    }
    throw new Error(`openclaw package not found: ${openclawDir}`);
  }

  const results = [];
  for (const patch of selectOpenClawPatches(patchIds)) {
    const result = patch.apply(openclawDir);
    results.push({ id: patch.id, ...result });
    const icon = result.status === 'applied' ? '🧩' : result.status === 'clean' ? '✅' : 'ℹ️';
    log(`${icon} OpenClaw patch ${patch.id} [${result.status}]: ${result.detail}`);
  }
  return results;
}
