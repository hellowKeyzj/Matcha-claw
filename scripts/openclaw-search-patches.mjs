import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const VERSION = '2026.10.8';
const PATCH = 'matcha-native-searxng-v3';
const CLIENT = 'searxng-client-DHycwhcy.mjs';
const PROVIDER = 'searxng-search-provider-G09qHDjp.mjs';
const ORIGINAL = {
  [CLIENT]: '43acb0ffe40c2dc9b4f87caabf80a61b29e13a633671db30f2a234605989e6cd',
  [PROVIDER]: '03da9cabd4426adc044f7a1f70df9187801b5a72d3be95ae8746f30d73647fd5',
  'openclaw.plugin.json': 'a42b2120cc0c34f02f5c1950e450f6b4f4110e191c58a3d6cb5a3b832ea56a16',
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

function patchFile(file, transform, expectedHash) {
  const original = read(file);
  const marker = `// ${PATCH}\n`;
  const stamp = original.match(new RegExp(`^// ${PATCH} sha256=([a-f0-9]{64})\\n`));
  if (stamp) {
    if (digest(original.slice(stamp[0].length)) !== stamp[1]) throw new Error(`${PATCH}: patched source drift: ${path.basename(file)}`);
    return false;
  }
  if (expectedHash && digest(original) !== expectedHash) throw new Error(`${PATCH}: upstream source changed: ${path.basename(file)}`);
  const next = marker + transform(original);
  fs.writeFileSync(file, `// ${PATCH} sha256=${digest(next)}\n${next}`);
  return true;
}

function patchClient(source) {
  source = replace(source, 'function resolveSearxngCategories(config) {\n\treturn normalizeOptionalString(resolveSearxngWebSearchConfig(config)?.categories);\n}\n', '');
  source = replace(source, 'function shouldRetryEmptyCategorySearchWithGeneral(categories) {\n\tif (!categories) return false;\n\tconst normalized = categories.split(",").map((category) => category.trim().toLowerCase()).filter((category) => category.length > 0);\n\treturn normalized.length > 0 && !normalized.includes("general");\n}\n', '');
  source = replace(source, '\tif (params.categories) url.searchParams.set("categories", params.categories);', '\tif (params.engines) url.searchParams.set("engines", params.engines);\n\telse if (params.categories) url.searchParams.set("categories", params.categories);\n\turl.searchParams.set("safesearch", String(params.safeSearch));\n\turl.searchParams.set("count", String(params.count));');
  source = replace(source, '\tconst rawResults = asOptionalObjectRecord(parsed)?.results;', '\tconst response = asOptionalObjectRecord(parsed);\n\tif (!response) throw new Error("SearXNG returned an invalid search response.");\n\tconst rawResults = response.results;');
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
\tif (!Array.isArray(catalog?.engines)) throw new Error("SearXNG engine catalog is invalid.");
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
  source = replace(source, 'async function runSearxngSearch(params) {\n\tparams.signal?.throwIfAborted();', 'async function runSearxngSearch(params) {\n\tparams.signal?.throwIfAborted();\n\tif (/(?:^|\\s)[!:<]\\S*/u.test(params.query)) throw new Error("SearXNG query directives are unsupported; use structured search options.");');
  source = replace(source, '\tconst count = resolveSearchCount(params.count, DEFAULT_SEARCH_COUNT);\n\tconst categories = params.categories ?? resolveSearxngCategories(params.config);', '\tconst defaults = resolveSearxngWebSearchConfig(params.config);\n\tconst requestedCount = params.count ?? defaults?.resultCount ?? DEFAULT_SEARCH_COUNT;\n\tif (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 10) throw new Error("count must be an integer from 1 to 10.");\n\tconst count = resolveSearchCount(requestedCount, DEFAULT_SEARCH_COUNT);\n\tconst categories = readSelectionCsv(params.categories ?? (defaults?.categories === "" ? void 0 : defaults?.categories), "categories");\n\tconst engines = readSelectionCsv(params.engines ?? defaults?.engines, "engines");\n\tconst safeSearch = readSafeSearch(params.safesearch ?? defaults?.safeSearch ?? 0);\n\tconst revision = defaults?.revision ?? "";');
  source = replace(source, '\tconst timeoutSeconds = resolveTimeoutSeconds(params.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);', '\tlet timeoutSeconds = resolveTimeoutSeconds(params.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);');
  source = replace(source, '\tconst endpointMode = await validateSearxngBaseUrl(baseUrl);', '\tconst endpointMode = await validateSearxngBaseUrl(baseUrl);\n\tif (endpointMode === "selfHosted") timeoutSeconds = Math.max(timeoutSeconds, 135);');
  source = replace(source, '\t\tcategories: categories ?? "",\n\t\tlanguage: language ?? "",', '\t\tcategories: categories ?? "",\n\t\tengines: engines ?? "",\n\t\tsafeSearch,\n\t\trevision,\n\t\tlanguage: language ?? "",');
  source = replace(source, '\tconst startedAt = Date.now();\n\tconst request = {', '\tconst startedAt = Date.now();\n\tparams = { ...params, signal: AbortSignal.any([...(params.signal ? [params.signal] : []), AbortSignal.timeout(timeoutSeconds * 1000)]) };\n\tconst exactEngines = await resolveExactSearxngSelection({ baseUrl, categories, engines, endpointMode, timeoutSeconds, signal: params.signal });\n\tconst request = {');
  source = replace(source, '\t\tcategories,\n\t\tlanguage,\n\t\ttimeoutSeconds,', '\t\tcategories: exactEngines ? void 0 : categories,\n\t\tengines: exactEngines,\n\t\tsafeSearch,\n\t\tlanguage,\n\t\ttimeoutSeconds,');
  source = replace(source, '\tlet results = await fetchSearxngResults(request);\n\tparams.signal?.throwIfAborted();\n\tif (results.length === 0 && shouldRetryEmptyCategorySearchWithGeneral(categories)) {\n\t\tresults = await fetchSearxngResults({\n\t\t\t...request,\n\t\t\tcategories: "general"\n\t\t});\n\t\tparams.signal?.throwIfAborted();\n\t}', '\tconst { results, unresponsiveEngines } = await fetchSearxngResults(request);\n\tparams.signal?.throwIfAborted();');
  return replace(source, '\t\tcount: results.length,\n\t\ttookMs:', '\t\tcount: results.length,\n\t\tunresponsiveEngines,\n\t\ttookMs:');
}

export function patchSearxngPlugin(pluginDir) {
  version(pluginDir, '@openclaw/searxng-plugin');
  const dist = path.join(pluginDir, 'dist', '.setup');
  const files = [
    [path.join(dist, CLIENT), patchClient, ORIGINAL[CLIENT]],
    [path.join(dist, PROVIDER), (source) => {
      source = replace(source, 'import { readPositiveIntegerParam, readStringParam }', 'import { readStringParam }');
      source = replace(source, '\t\tlanguage: {\n\t\t\ttype: "string",', '\t\tengines: { type: "string", description: "Exact comma-separated SearXNG engine ids; intersected with categories when both are supplied." },\n\t\tsafesearch: { type: "integer", minimum: 0, maximum: 2, description: "Safe search: 0 off, 1 moderate, 2 strict." },\n\t\tlanguage: {\n\t\t\ttype: "string",');
      return replace(source, '\t\t\t\t\tcount: readPositiveIntegerParam(args, "count", {\n\t\t\t\t\t\tmax: 10,\n\t\t\t\t\t\tmessage: "count must be an integer from 1 to 10."\n\t\t\t\t\t}),\n\t\t\t\t\tcategories: readStringParam(args, "categories"),', '\t\t\t\t\tcount: args.count,\n\t\t\t\t\tengines: args.engines,\n\t\t\t\t\tsafesearch: args.safesearch,\n\t\t\t\t\tcategories: args.categories,');
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
  } else if (digest(source) !== '185d0f8c46c49ac4dd593f9ee649d6a3c2a6b8b5f0fe2bd36cf86bca21ed15b8') {
    throw new Error(`${PATCH}: patched plugin manifest drift`);
  }
  return { status: changed ? 'applied' : 'clean', detail: 'official searxng 2026.10.8 native options' };
}

export function patchOpenClawSearch(openclawDir) {
  version(openclawDir, 'openclaw');
  const dist = path.join(openclawDir, 'dist');
  const reload = locate(dist, 'server-reload-managed-', ['function startGatewayConfigReloader(opts)', 'function createGatewayReloadHandlers(params)']);
  let changed = patchFile(reload, (source) => replace(source, '\t\t\tthrow error;\n\t\t} finally {\n\t\t\treleasePreparedModelRuntimeDrain?.();', '\t\t\tif (!runtimeCommitted && publication?.isCurrent() === false) throw createReloadCancellationError(true);\n\t\t\tthrow error;\n\t\t} finally {\n\t\t\treleasePreparedModelRuntimeDrain?.();'), '428a642055344a6869578f709acaa7754adfaadbf5c7f6312de8170f0305e0b4');
  const tools = locate(dist, 'openclaw-tools-', ['const WebSearchSchema = {', 'function createWebSearchTool(options)']);
  changed = patchFile(tools, (source) => replace(source, '\t\t\tdescription: "Search query."\n\t\t},\n\t\tcount:', '\t\t\tdescription: "Search query."\n\t\t},\n\t\tcategories: { type: "string", description: "SearXNG comma-separated categories." },\n\t\tengines: { type: "string", description: "Exact SearXNG engine ids; intersected with categories." },\n\t\tsafesearch: { type: "integer", minimum: 0, maximum: 2, description: "SearXNG safe search level." },\n\t\tcount:')) || changed;
  const output = locate(dist, 'web-search-output-', ['const WebSearchOutputSchema =', 'function normalizeWebSearchOutput(params)']);
  changed = patchFile(output, (source) => {
    source = replace(source, '\t\tresults: Type.Array(WebSearchResultSchema),', '\t\tunresponsiveEngines: Type.Optional(Type.Array(Type.Tuple([Type.String(), Type.String()]))),\n\t\tresults: Type.Array(WebSearchResultSchema),');
    return replace(source, '\t\t\tcount: rows.length !== results.length ? results.length : asFiniteNumber(result.count) ?? results.length,', '\t\t\tcount: rows.length !== results.length ? results.length : asFiniteNumber(result.count) ?? results.length,\n\t\t\t...(provider === "searxng" && Array.isArray(result.unresponsiveEngines) ? { unresponsiveEngines: result.unresponsiveEngines.slice(0, 100).filter((row) => Array.isArray(row) && row.length === 2 && row.every((v) => typeof v === "string")).map(([engine, reason]) => [wrapProse(engine.slice(0, 128)), wrapProse(reason.slice(0, 512))]) } : {}),');
  }, 'a530844c14a83f0f10d588d46b5dec6e2dc36e09a6041ca77cdc34386ce13080') || changed;
  const scopes = locate(dist, 'core-method-policy-', ['const CORE_GATEWAY_METHOD_SPECS = [', '"tools.invoke",']);
  changed = patchFile(scopes, (source) => replace(source, '\t[\n\t\t"tools.invoke",', '\t[\n\t\t"webSearch/status",\n\t\t"tools-invoke",\n\t\t"operator.read",\n\t\t"2026.9",\n\t\t{ startup: true }\n\t],\n\t[\n\t\t"tools.invoke",'), '015897fa1de4d1d1a0e92261cca874407927690ab2614e9d6e306e907139c7f9') || changed;
  const handler = locate(dist, 'tools-invoke-', ['const toolsInvokeHandlers = {', '"tools.invoke": async', 'assertInvocationCurrent:']);
  const runtime = locate(dist, 'runtime-', ['function isWebSearchProviderConfigured(params)', 'function runWebSearch(params)']);
  const context = locate(dist, 'web-tool-runtime-context-', ['function resolveWebToolRuntimeContext(params)']);
  const registry = locate(dist, 'gateway-request-scope-', ['function getPluginRegistryForContext()']);
  const generation = locate(dist, 'generation-state-', ['function getPluginRuntimeGenerationRegistry()']);
  const instances = locate(dist, 'plugin-instance-scope-', ['function getPluginInstance(record)']);
  const providers = locate(dist, 'web-provider-public-artifacts-', ['function mapRegistryProviders(params)']);
  changed = patchFile(handler, (source) => {
    const imports = `import { ${alias(runtime, 'isWebSearchProviderConfigured')} as matchaSearchConfigured } from "./${path.basename(runtime)}";
import { ${alias(context, 'resolveWebToolRuntimeContext')} as matchaSearchContext } from "./${path.basename(context)}";
import { ${alias(registry, 'getPluginRegistryForContext')} as matchaSearchRegistry } from "./${path.basename(registry)}";
import { ${alias(generation, 'getPluginRuntimeGenerationRegistry')} as matchaSearchGeneration } from "./${path.basename(generation)}";
import { ${alias(instances, 'getPluginInstance')} as matchaSearchInstance } from "./${path.basename(instances)}";
import { ${alias(providers, 'mapRegistryProviders')} as matchaSearchProviders } from "./${path.basename(providers)}";
`;
    return imports + replace(source, 'const toolsInvokeHandlers = { "tools.invoke": async', `const toolsInvokeHandlers = { "webSearch/status": ({ params, respond, context }) => {
\tif (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length !== 0) {
\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "webSearch/status takes no parameters")); return;
\t}
\tconst { config, providerSelectionId: selectedProvider, runtimeMetadata } = matchaSearchContext({ kind: "search", config: context.getRuntimeConfig(), lateBindRuntimeConfig: true });
\tconst plugins = config.plugins;
\tconst policyBlocked = plugins?.enabled === false || plugins?.deny?.includes("searxng") || (plugins?.allow?.length > 0 && !plugins.allow.includes("searxng")) || plugins?.entries?.searxng?.enabled === false || config.tools?.web?.search?.enabled === false;
\tconst registry = matchaSearchGeneration() ?? matchaSearchRegistry();
\tconst record = registry?.plugins.find((entry) => entry.id === "searxng");
\tconst instance = record && matchaSearchInstance(record);
\tlet provider;
\tif (!policyBlocked && selectedProvider === "searxng" && record?.status === "loaded" && instance?.acceptingCalls) provider = matchaSearchProviders({ registry, entries: registry.webSearchProviders, onlyPluginIds: ["searxng"] }).find((entry) => entry.id === "searxng" && entry.pluginId === "searxng");
\tconst definition = provider?.createTool({ config, searchConfig: config.tools?.web?.search, runtimeMetadata });
\trespond(true, { selectedProvider, policyBlocked, revision: config.plugins?.entries?.searxng?.config?.webSearch?.revision ?? null, loaded: typeof definition?.execute === "function", configured: provider ? matchaSearchConfigured({ provider, config }) : false }, void 0);
}, "tools.invoke": async`);
  }, '5009df024f87f8e4f0bdaae79868e04a34b4d9b727c42a1836a5781613838fb8') || changed;
  const require = createRequire(path.join(openclawDir, 'package.json'));
  const pluginDir = path.dirname(require.resolve('@openclaw/searxng-plugin/package.json'));
  const plugin = patchSearxngPlugin(pluginDir);
  return { status: changed || plugin.status === 'applied' ? 'applied' : 'clean', detail: 'native SearXNG schema, provider, cache, status and official plugin' };
}
