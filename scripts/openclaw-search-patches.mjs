import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const VERSION = '2026.9.3';
const PATCH = 'matcha-native-searxng-v3';
const CLIENT = 'searxng-client-BIItF13t.js';
const PROVIDER = 'searxng-search-provider-B6mCxK0T.js';
const ORIGINAL = {
  [CLIENT]: '62840592a323168b184234a7248b1a41f70b16d797c8748af2a1dba761bdd3a4',
  [PROVIDER]: 'cbee098045face512898739589576182f83afb38fc7b724e2dad49ca6d5e6407',
  'openclaw.plugin.json': '3da65cd78744140f5aa699deedd32a94663a33d79d32daa68a0f22f4272ab87c',
};
const read = (file) => fs.readFileSync(file, 'utf8');
const digest = (source) => createHash('sha256').update(source).digest('hex');

function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`${PATCH}: source anchor mismatch: ${before.slice(0, 100)}`);
  return source.replace(before, after);
}

function locate(dir, prefix, markers) {
  const files = fs.readdirSync(dir).filter((name) => name.startsWith(prefix) && /\.(?:mjs|js)$/.test(name))
    .map((name) => path.join(dir, name)).filter((file) => markers.every((marker) => read(file).includes(marker)));
  if (files.length !== 1) throw new Error(`${PATCH}: expected one ${prefix} source, found ${files.length}`);
  return files[0];
}

function version(dir, name) {
  const pkg = JSON.parse(read(path.join(dir, 'package.json')));
  if (pkg.name !== name || pkg.version !== VERSION) throw new Error(`${PATCH}: requires ${name}@${VERSION}`);
}

function alias(file, name) {
  const source = read(file);
  const result = source.match(new RegExp(`\\b${name} as ([\\w$]+)\\b`));
  if (result) return result[1];
  throw new Error(`${PATCH}: missing native export ${name}`);
}

function patchSearchBudget(source) {
  source = replace(source, '\tconst timeoutSeconds = resolveTimeoutSeconds(params.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);', '\tlet timeoutSeconds = resolveTimeoutSeconds(params.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);');
  return replace(source, '\tconst endpointMode = await validateSearxngBaseUrl(baseUrl);', '\tconst endpointMode = await validateSearxngBaseUrl(baseUrl);\n\tif (endpointMode === "selfHosted") timeoutSeconds = Math.max(timeoutSeconds, 135);');
}

function patchFile(file, transform, expectedHash) {
  const original = read(file);
  const marker = `// ${PATCH}\n`;
  const stamp = original.match(new RegExp(`^// ${PATCH} sha256=([a-f0-9]{64})\\n`));
  if (stamp) {
    if (digest(original.slice(stamp[0].length)) !== stamp[1]) throw new Error(`${PATCH}: patched source drift: ${path.basename(file)}`);
    return false;
  }
  if (expectedHash && digest(original) !== expectedHash) throw new Error(`${PATCH}: upstream source changed: ${path.basename(file)}`);
  let body = transform(original);
  if (path.basename(file) === CLIENT) body = patchSearchBudget(body);
  const next = marker + body;
  fs.writeFileSync(file, `// ${PATCH} sha256=${digest(next)}\n${next}`);
  return true;
}

function patchClient(source) {
  source = replace(source, 'function shouldRetryEmptyCategorySearchWithGeneral(categories) {\n\tif (!categories) return false;\n\tconst normalized = categories.split(",").map((category) => category.trim().toLowerCase()).filter((category) => category.length > 0);\n\treturn normalized.length > 0 && !normalized.includes("general");\n}\n', '');
  source = replace(source, '\tif (params.categories) url.searchParams.set("categories", params.categories);', '\tif (params.engines) url.searchParams.set("engines", params.engines);\n\telse if (params.categories) url.searchParams.set("categories", params.categories);\n\turl.searchParams.set("safesearch", String(params.safeSearch));\n\turl.searchParams.set("count", String(params.count));');
  source = replace(source, '\tif (!parsed || typeof parsed !== "object") return [];', '\tif (!parsed || typeof parsed !== "object") throw new Error("SearXNG returned an invalid search response.");');
  source = replace(source, '\treturn results;\n}\nasync function fetchSearxngResults', '\treturn { results, unresponsiveEngines: response.unresponsive_engines ?? null };\n}\nasync function fetchSearxngResults');
  source = replace(source, '\t\tcategories: params.categories,\n\t\tlanguage: params.language\n', '\t\tcategories: params.categories,\n\t\tengines: params.engines,\n\t\tsafeSearch: params.safeSearch,\n\t\tcount: params.count,\n\t\tlanguage: params.language\n');
  source = replace(source, 'async function runSearxngSearch(params) {', `function readSelectionCsv(value, label) {
\tif (value === void 0) return;
\tif (typeof value !== "string" || value.length > 4096) throw new Error(label + " must be a comma-separated string.");
\tconst names = value.split(",").map((name) => name.trim());
\tif (names.some((name) => !name)) throw new Error(label + " must not contain empty selections.");
\treturn [...new Set(names)].join(",");
}
function readSafeSearch(value) {
\tif (!Number.isInteger(value) || value < 0 || value > 2) throw new Error("safesearch must be 0, 1, or 2.");
\treturn value;
}
async function resolveExactSearxngSelection(params) {
\tif (!params.engines && !params.categories) return;
\tconst url = new URL(params.baseUrl);
\turl.pathname = url.pathname.replace(/\\/+$/u, "").replace(/\\/search$/u, "") + "/config";
\turl.search = "";
\tconst catalog = await (params.endpointMode === "selfHosted" ? withSelfHostedWebSearchEndpoint : withTrustedWebSearchEndpoint)({
\t\turl: url.toString(), timeoutSeconds: params.timeoutSeconds, signal: params.signal,
\t\tinit: { method: "GET", headers: { Accept: "application/json" } }
\t}, async (response) => {
\t\tif (!response.ok) throw new Error("SearXNG engine catalog is unavailable.");
\t\tconst body = await readResponseText(response, { maxBytes: MAX_RESPONSE_BYTES });
\t\tif (body.truncated) throw new Error("SearXNG engine catalog is incomplete.");
\t\treturn JSON.parse(body.text);
\t});
\tparams.signal?.throwIfAborted();
\tif (!Array.isArray(catalog.engines)) throw new Error("SearXNG engine catalog is invalid.");
\tconst categories = params.categories?.split(",");
\tconst knownCategories = new Set(catalog.engines.flatMap((engine) => Array.isArray(engine.categories) ? engine.categories : []));
\tif (categories?.some((name) => !knownCategories.has(name))) throw new Error("Unknown SearXNG category.");
\tif (!params.engines) return;
\tconst engines = params.engines.split(",");
\tif (engines.some((name) => !catalog.engines.some((engine) => engine.name === name))) throw new Error("Unknown SearXNG engine.");
\tconst selected = engines.filter((name) => !categories || catalog.engines.some((engine) => engine.name === name && engine.categories?.some((category) => categories.includes(category))));
\tif (!selected.length) throw new Error("SearXNG engines and categories have no intersection.");
\treturn selected.join(",");
}
async function runSearxngSearch(params) {`);
  source = replace(source, '\tconst count = resolveSearchCount(params.count, DEFAULT_SEARCH_COUNT);\n\tconst categories = params.categories ?? resolveSearxngCategories(params.config);', '\tconst defaults = resolveSearxngWebSearchConfig(params.config);\n\tconst requestedCount = params.count ?? defaults?.resultCount ?? DEFAULT_SEARCH_COUNT;\n\tif (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 10) throw new Error("count must be an integer from 1 to 10.");\n\tconst count = resolveSearchCount(requestedCount, DEFAULT_SEARCH_COUNT);\n\tconst categories = readSelectionCsv(params.categories ?? resolveSearxngCategories(params.config), "categories");\n\tconst engines = readSelectionCsv(params.engines ?? defaults?.engines, "engines");\n\tconst safeSearch = readSafeSearch(params.safesearch ?? defaults?.safeSearch ?? 0);\n\tconst revision = defaults?.revision ?? "";');
  source = replace(source, '\t\tcategories: categories ?? "",\n\t\tlanguage: language ?? "",', '\t\tcategories: categories ?? "",\n\t\tengines: engines ?? "",\n\t\tsafeSearch,\n\t\trevision,\n\t\tlanguage: language ?? "",');
  source = replace(source, '\tlet results = await fetchSearxngResults({', '\tconst exactEngines = await resolveExactSearxngSelection({ baseUrl, categories, engines, endpointMode, timeoutSeconds, signal: params.signal });\n\tconst response = await fetchSearxngResults({');
  source = replace(source, '\t\tcategories,\n\t\tlanguage,\n\t\ttimeoutSeconds,', '\t\tcategories: exactEngines ? void 0 : categories,\n\t\tengines: exactEngines,\n\t\tsafeSearch,\n\t\tlanguage,\n\t\ttimeoutSeconds,');
  const start = source.indexOf('\tif (results.length === 0 && shouldRetryEmptyCategorySearchWithGeneral(categories)) {');
  const end = source.indexOf('\n\tconst payload = {', start);
  if (start < 0 || end < 0) throw new Error(`${PATCH}: missing category retry source anchor`);
  source = source.slice(0, start) + '\tconst { results, unresponsiveEngines } = response;\n' + source.slice(end);
  source = replace(source, '\t\tcount: results.length,\n\t\ttookMs:', '\t\tcount: results.length,\n\t\tunresponsiveEngines,\n\t\ttookMs:');
  return finishClient(source);
}

function finishClient(source) {
  source = replace(source, 'async function runSearxngSearch(params) {\n\tparams.signal?.throwIfAborted();', 'async function runSearxngSearch(params) {\n\tparams.signal?.throwIfAborted();\n\tif (/(?:^|\\s)[!:<]\\S*/u.test(params.query)) throw new Error("SearXNG query directives are unsupported; use structured search options.");');
  source = replace(source, 'params.categories ?? resolveSearxngCategories(params.config)', 'params.categories ?? (defaults?.categories === "" ? void 0 : defaults?.categories)');
  return replace(source, '\tconst startedAt = Date.now();\n\tconst exactEngines', '\tconst startedAt = Date.now();\n\tparams = { ...params, signal: AbortSignal.any([...(params.signal ? [params.signal] : []), AbortSignal.timeout(timeoutSeconds * 1000)]) };\n\tconst exactEngines');
}

function finishProvider(source) {
  source = replace(source, 'engines: readStringParam(args, "engines")', 'engines: args.engines');
  source = replace(source, 'categories: readStringParam(args, "categories")', 'categories: args.categories');
  return replace(source, 'count: readPositiveIntegerParam(args, "count", {\n\t\t\t\t\t\tmax: 10,\n\t\t\t\t\t\tmessage: "count must be an integer from 1 to 10."\n\t\t\t\t\t})', 'count: args.count');
}

export function patchSearxngPlugin(pluginDir) {
  version(pluginDir, '@openclaw/searxng-plugin');
  const dist = path.join(pluginDir, 'dist');
  const files = [
    [path.join(dist, CLIENT), patchClient, ORIGINAL[CLIENT]],
    [path.join(dist, PROVIDER), (source) => {
      source = replace(source, '\t\tlanguage: {\n\t\t\ttype: "string",', '\t\tengines: { type: "string", description: "Exact comma-separated SearXNG engine ids; intersected with categories when both are supplied." },\n\t\tsafesearch: { type: "integer", minimum: 0, maximum: 2, description: "Safe search: 0 off, 1 moderate, 2 strict." },\n\t\tlanguage: {\n\t\t\ttype: "string",');
      return finishProvider(replace(source, '\t\t\t\t\tcategories: readStringParam(args, "categories"),', '\t\t\t\t\tengines: readStringParam(args, "engines"),\n\t\t\t\t\tsafesearch: args.safesearch,\n\t\t\t\t\tcategories: readStringParam(args, "categories"),'));
    }, ORIGINAL[PROVIDER]],
  ];
  let changed = false;
  for (const [file, transform, hash] of files) changed = patchFile(file, transform, hash) || changed;
  const manifestFile = path.join(pluginDir, 'openclaw.plugin.json');
  const source = read(manifestFile);
  const manifest = JSON.parse(source);
  const fields = { engines: { type: 'string' }, safeSearch: { type: 'integer', minimum: 0, maximum: 2 }, resultCount: { type: 'integer', minimum: 1, maximum: 10 }, revision: { type: 'string' } };
  if (manifest.configSchema.properties.webSearch.properties.revision === undefined) {
    if (digest(source) !== ORIGINAL['openclaw.plugin.json']) throw new Error(`${PATCH}: plugin manifest source changed`);
    Object.assign(manifest.configSchema.properties.webSearch.properties, fields);
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    changed = true;
  } else if (digest(source) !== '889ce9e96c96d89ffaa9c45601fd97061923172fd34a10e45f685e825c94cfa3') {
    throw new Error(`${PATCH}: patched plugin manifest drift`);
  }
  return { status: changed ? 'applied' : 'clean', detail: 'official searxng 2026.9.3 native options' };
}

export function patchOpenClawSearch(openclawDir) {
  version(openclawDir, 'openclaw');
  const dist = path.join(openclawDir, 'dist');
  const reload = locate(dist, 'server-reload-managed-', ['function startGatewayConfigReloader(opts)', 'function createGatewayReloadHandlers(params)']);
  // The registry applies provider-config-debug-trace before this patch.
  let changed = patchFile(reload, (source) => replace(source, '\t\t\t\t\t\tif (replacementTeardownFailed) throw err;', '\t\t\t\t\t\tif (replacementTeardownFailed) {\n\t\t\t\t\t\t\tif (publication?.isCurrent() === false) throw createReloadCancellationError(true);\n\t\t\t\t\t\t\tthrow err;\n\t\t\t\t\t\t}'), 'b5c42f930290a7e6e0b8fb5455f830671364b16a96d7d70016dbc52c09f95ba4');
  const tools = locate(dist, 'openclaw-tools-', ['const WebSearchSchema = {', 'function normalizeWebSearchOutput(params)', 'function createWebSearchTool(options)']);
  changed = patchFile(tools, (source) => {
    source = replace(source, '\t\t\tdescription: "Search query."\n\t\t},\n\t\tcount:', '\t\t\tdescription: "Search query."\n\t\t},\n\t\tcategories: { type: "string", description: "SearXNG comma-separated categories." },\n\t\tengines: { type: "string", description: "Exact SearXNG engine ids; intersected with categories." },\n\t\tsafesearch: { type: "integer", minimum: 0, maximum: 2, description: "SearXNG safe search level." },\n\t\tcount:');
    source = replace(source, '\t\tresults: Type.Array(WebSearchResultSchema),', '\t\tunresponsiveEngines: Type.Optional(Type.Array(Type.Tuple([Type.String(), Type.String()]))),\n\t\tresults: Type.Array(WebSearchResultSchema),');
    return replace(source, '\t\t\tcount: rows.length !== results.length ? results.length : asFiniteNumber(result.count) ?? results.length,', '\t\t\tcount: rows.length !== results.length ? results.length : asFiniteNumber(result.count) ?? results.length,\n\t\t\t...(provider === "searxng" && Array.isArray(result.unresponsiveEngines) ? { unresponsiveEngines: result.unresponsiveEngines.slice(0, 100).filter((row) => Array.isArray(row) && row.length === 2 && row.every((v) => typeof v === "string")).map(([engine, reason]) => [wrapProse(engine.slice(0, 128)), wrapProse(reason.slice(0, 512))]) } : {}),');
  }) || changed;
  const scopes = locate(dist, 'method-scopes-', ['const CORE_GATEWAY_METHOD_SPECS = [', '"tools.invoke",']);
  changed = patchFile(scopes, (source) => replace(source, '\t[\n\t\t"tools.invoke",', '\t[\n\t\t"webSearch/status",\n\t\t"tools-invoke",\n\t\t"operator.read",\n\t\t"2026.9",\n\t\t{ startup: true }\n\t],\n\t[\n\t\t"tools.invoke",')) || changed;
  const handler = locate(dist, 'tools-invoke-', ['const toolsInvokeHandlers = {', '"tools.invoke": async', 'function resolveRpcErrorCode(params)']);
  const resolver = locate(dist, 'web-search-providers.runtime-', ['function resolvePluginWebSearchProviders(params)']);
  const runtime = locate(dist, 'runtime-', ['function isWebSearchProviderConfigured(params)', 'function runWebSearch(params)']);
  const secrets = locate(dist, 'runtime-state-', ['function getActiveSecretsRuntimeConfigSnapshot(']);
  const metadata = locate(dist, 'runtime-web-tools-state-', ['function getActiveRuntimeWebToolsMetadataFromState(']);
  const finishStatus = (source) => {
    source = replace(source, 'const config = context.getRuntimeConfig();\n\tconst selectedProvider = config.tools?.web?.search?.provider ?? "";', 'const config = matchaActiveSearchConfig()?.config ?? context.getRuntimeConfig();\n\tconst runtimeSearch = matchaActiveSearchMetadata()?.search;\n\tconst selectedProvider = runtimeSearch?.selectedProvider ?? runtimeSearch?.providerConfigured ?? config.tools?.web?.search?.provider ?? "";');
    return `import { ${alias(secrets, 'getActiveSecretsRuntimeConfigSnapshot')} as matchaActiveSearchConfig } from "./${path.basename(secrets)}";\nimport { ${alias(metadata, 'getActiveRuntimeWebToolsMetadataFromState')} as matchaActiveSearchMetadata } from "./${path.basename(metadata)}";\n` + source;
  };
  changed = patchFile(handler, (source) => {
    const imports = `import { ${alias(resolver, 'resolveRuntimeWebSearchProviders')} as matchaSearchProviders } from "./${path.basename(resolver)}";\nimport { ${alias(runtime, 'isWebSearchProviderConfigured')} as matchaSearchConfigured } from "./${path.basename(runtime)}";\n`;
    return finishStatus(imports + replace(source, 'const toolsInvokeHandlers = { "tools.invoke": async', `const toolsInvokeHandlers = { "webSearch/status": ({ params, respond, context }) => {
\tif (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length !== 0) {
\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "webSearch/status takes no parameters")); return;
\t}
\tconst config = context.getRuntimeConfig();
\tconst selectedProvider = config.tools?.web?.search?.provider ?? "";
\tconst plugins = config.plugins;
\tconst policyBlocked = plugins?.enabled === false || plugins?.deny?.includes("searxng") || (plugins?.allow?.length > 0 && !plugins.allow.includes("searxng")) || plugins?.entries?.searxng?.enabled === false || config.tools?.web?.search?.enabled === false;
\tlet provider;
\tif (!policyBlocked && selectedProvider === "searxng") provider = matchaSearchProviders({ config, onlyPluginIds: ["searxng"] }).find((entry) => entry.id === "searxng" && entry.pluginId === "searxng");
\tconst definition = provider?.createTool({ config, searchConfig: config.tools?.web?.search });
\trespond(true, { selectedProvider, policyBlocked, revision: config.plugins?.entries?.searxng?.config?.webSearch?.revision ?? null, loaded: typeof definition?.execute === "function", configured: provider ? matchaSearchConfigured({ provider, config }) : false }, void 0);
}, "tools.invoke": async`));
  }) || changed;
  const require = createRequire(import.meta.url);
  const pluginDir = path.dirname(require.resolve('@openclaw/searxng-plugin/package.json'));
  const plugin = patchSearxngPlugin(pluginDir);
  return { status: changed || plugin.status === 'applied' ? 'applied' : 'clean', detail: 'native SearXNG schema, provider, cache, status and official plugin' };
}
