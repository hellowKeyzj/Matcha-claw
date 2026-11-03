import fs from 'node:fs';
import path from 'node:path';

const VERSION = '2026.9.3';
const PATCH = 'native-account-media';
const read = (file) => fs.readFileSync(file, 'utf8');

function replace(source, before, after) {
  if (source.split(after).length === 2) return source;
  if (source.includes(after) || source.split(before).length !== 2) {
    throw new Error(`${PATCH}: source anchor mismatch: ${before.slice(0, 100)}`);
  }
  return source.replace(before, after);
}

function locate(dist, prefix, markers) {
  const files = fs.readdirSync(dist).filter((name) => name.startsWith(prefix) && /\.(?:mjs|js)$/.test(name))
    .map((name) => path.join(dist, name)).filter((file) => markers.every((marker) => read(file).includes(marker)));
  if (files.length !== 1) throw new Error(`${PATCH}: expected one ${prefix} source, found ${files.length}`);
  return files[0];
}

function patchSchema(source) {
  return replace(source, '\tmodels: array(ModelDefinitionSchema).optional()', `\tmedia: object({
\t\tapi: _enum(["openai", "google", "openrouter"]),
\t\tmodels: array(object({
\t\t\tid: string().min(1).max(512).refine((value) => Buffer.byteLength(value, "utf8") <= 512),
\t\t\tcapabilities: array(_enum(["imageGenerate", "videoGenerate", "musicGenerate", "tts", "transcribe"])).min(1),
\t\t\ttimeoutMs: number().int().positive().optional(),
\t\t\taspectRatio: string().min(1).max(128).refine((value) => Buffer.byteLength(value, "utf8") <= 128).optional(),
\t\t\tresolution: string().min(1).max(128).refine((value) => Buffer.byteLength(value, "utf8") <= 128).optional(),
\t\t\tquality: string().min(1).max(128).refine((value) => Buffer.byteLength(value, "utf8") <= 128).optional()
\t\t}).strict())
\t}).strict().optional(),
\tmodels: array(ModelDefinitionSchema).optional()`);
}

function registration(protocol, nativeCall, mediaCall) {
  return `\t\tif (!api.config.models?.providers?.${protocol}?.media?.models.some((model) => model.capabilities.includes("imageGenerate"))) ${nativeCall}
\t\tfor (const [providerId, providerConfig] of Object.entries(api.config.models?.providers ?? {})) {
\t\t\tconst media = providerConfig.media;
\t\t\tif (media?.api !== "${protocol}" || !media.models.some((model) => model.capabilities.includes("imageGenerate"))) continue;
\t\t\t${mediaCall}
\t\t}`;
}

function patchOpenAIRegistration(source) {
  const native = `api.registerImageGenerationProvider(buildOpenAIImageGenerationProvider({
\t\t\tensureAuthProfileStore,
\t\t\tlistProfilesForProvider,
\t\t\tisProviderApiKeyConfigured
\t\t}));`;
  return replace(source, `\t\t${native}`, registration('openai', native,
    'api.registerImageGenerationProvider(buildOpenAIImageGenerationProvider({ ensureAuthProfileStore, listProfilesForProvider, isProviderApiKeyConfigured }, providerId, media));'));
}

function patchOpenAIFactory(source) {
  source = replace(source, '//#region extensions/openai/image-generation-provider.ts', `import { createOpenAiCompatibleImageGenerationProvider } from "./plugin-sdk/image-generation.js";
//#region extensions/openai/image-generation-provider.ts`);
  return replace(source, 'function buildOpenAIImageGenerationProvider(modelAuth) {', `function buildOpenAIMediaImageGenerationProvider(providerId, media) {
\tconst models = media.models.filter((model) => model.capabilities.includes("imageGenerate")).map((model) => model.id);
\tconst native = createOpenAIImageGenerationProviderBase({ id: providerId, label: providerId });
\treturn createOpenAiCompatibleImageGenerationProvider({
\t\tid: providerId,
\t\tlabel: providerId,
\t\tdefaultModel: models[0],
\t\tmodels,
\t\tcapabilities: native.capabilities,
\t\tdefaultBaseUrl: DEFAULT_OPENAI_IMAGE_BASE_URL,
\t\tdefaultTimeoutMs: DEFAULT_OPENAI_IMAGE_TIMEOUT_MS,
\t\tuseConfiguredRequest: true,
\t\tresolveCount: ({ req }) => resolveOpenAIImageCount(req.count),
\t\tbuildGenerateRequest: ({ req, model, count }) => {
\t\t\tconst body = { model, prompt: req.prompt, n: count, size: req.size ?? DEFAULT_SIZE };
\t\t\tappendOpenAIImageOptions(body, req);
\t\t\treturn { kind: "json", body };
\t\t},
\t\tbuildEditRequest: ({ req, inputImages, model, count }) => {
\t\t\tconst form = new FormData();
\t\t\tform.set("model", model);
\t\t\tform.set("prompt", req.prompt);
\t\t\tform.set("n", String(count));
\t\t\tform.set("size", req.size ?? DEFAULT_SIZE);
\t\t\tappendOpenAIImageOptions(form, req);
\t\t\tfor (const [index, image] of inputImages.entries()) {
\t\t\t\tconst mimeType = image.mimeType?.trim() || DEFAULT_OUTPUT_MIME;
\t\t\t\tform.append("image[]", new Blob([bufferToBlobPart(image.buffer)], { type: mimeType }), inferImageUploadFileName({ fileName: image.fileName, mimeType, index }));
\t\t\t}
\t\t\treturn { kind: "multipart", form };
\t\t},
\t\tresponse: { sniffMimeType: true }
\t});
}
function buildOpenAIImageGenerationProvider(modelAuth, providerId = "openai", media) {
\tif (media) return buildOpenAIMediaImageGenerationProvider(providerId, media);`);
}

function patchGoogleRegistration(source) {
  source = replace(source, 'async function loadGoogleImageGenerationProvider() {', `async function loadGoogleImageGenerationProvider(providerId = "google", media) {
\tif (media) return (await import("./image-generation-provider.js")).buildGoogleImageGenerationProvider(providerId, media);`);
  source = replace(source, 'function createLazyGoogleImageGenerationProvider() {', 'function createLazyGoogleImageGenerationProvider(providerId = "google", media) {');
  source = replace(source, `\t\tid: "google",
\t\tlabel: "Google",
\t\tdefaultModel: "gemini-3.1-flash-image",
\t\tmodels: ["gemini-3.1-flash-image", "gemini-3-pro-image"],`, `\t\tid: providerId,
\t\tlabel: "Google",
\t\tdefaultModel: media?.models.find((model) => model.capabilities.includes("imageGenerate"))?.id ?? "gemini-3.1-flash-image",
\t\tmodels: media ? media.models.filter((model) => model.capabilities.includes("imageGenerate")).map((model) => model.id) : ["gemini-3.1-flash-image", "gemini-3-pro-image"],`);
  source = replace(source, 'generateImage: async (req) => (await loadGoogleImageGenerationProvider()).generateImage(req)',
    'generateImage: async (req) => (await loadGoogleImageGenerationProvider(providerId, media)).generateImage(req)');
  return replace(source, '\t\tapi.registerImageGenerationProvider(createLazyGoogleImageGenerationProvider());',
    registration('google', 'api.registerImageGenerationProvider(createLazyGoogleImageGenerationProvider());',
      'api.registerImageGenerationProvider(createLazyGoogleImageGenerationProvider(providerId, media));'));
}

function patchGoogleFactory(source) {
  source = replace(source, 'function buildGoogleImageGenerationProvider() {', 'function buildGoogleImageGenerationProvider(providerId = "google", media) {');
  source = replace(source, '\t\tid: "google",', '\t\tid: providerId,');
  source = replace(source, '\t\tdefaultModel: DEFAULT_GOOGLE_IMAGE_MODEL,', '\t\tdefaultModel: media?.models.find((model) => model.capabilities.includes("imageGenerate"))?.id ?? DEFAULT_GOOGLE_IMAGE_MODEL,');
  source = replace(source, '\t\tmodels: [DEFAULT_GOOGLE_IMAGE_MODEL, "gemini-3-pro-image"],', '\t\tmodels: media ? media.models.filter((model) => model.capabilities.includes("imageGenerate")).map((model) => model.id) : [DEFAULT_GOOGLE_IMAGE_MODEL, "gemini-3-pro-image"],');
  for (const indent of ['\t\t\t', '\t\t\t\t']) {
    source = replace(source, `\n${indent}provider: "google",`, `\n${indent}provider: providerId,`);
  }
  source = replace(source, '\t\t\t\tbaseUrl: req.cfg?.models?.providers?.google?.baseUrl,', '\t\t\t\t...media ? { providerId } : {},\n\t\t\t\tbaseUrl: req.cfg?.models?.providers?.[providerId]?.baseUrl,');
  return replace(source, 'sanitizeConfiguredModelProviderRequest(req.cfg?.models?.providers?.google?.request)', 'sanitizeConfiguredModelProviderRequest(req.cfg?.models?.providers?.[providerId]?.request)');
}

function patchGoogleHttp(source) {
  source = replace(source, '\tconst baseUrl = resolveTrustedGoogleGenerativeAiBaseUrl(params.baseUrl);', '\tconst baseUrl = params.providerId ? normalizeGoogleGenerativeAiBaseUrl(params.baseUrl) : resolveTrustedGoogleGenerativeAiBaseUrl(params.baseUrl);');
  return replace(source, '\t\tprovider: "google",', '\t\tprovider: params.providerId ?? "google",');
}

function patchOpenRouterRegistration(source) {
  return replace(source, '\t\tapi.registerImageGenerationProvider(buildOpenRouterImageGenerationProvider());',
    registration('openrouter', 'api.registerImageGenerationProvider(buildOpenRouterImageGenerationProvider());',
      'api.registerImageGenerationProvider(buildOpenRouterImageGenerationProvider(providerId, media));'));
}

function patchOpenRouterFactory(source) {
  source = replace(source, 'function buildOpenRouterImageGenerationProvider() {', 'function buildOpenRouterImageGenerationProvider(providerId = "openrouter", media) {');
  source = replace(source, '\t\tid: "openrouter",', '\t\tid: providerId,');
  source = replace(source, '\t\tdefaultModel: DEFAULT_MODEL,', '\t\tdefaultModel: media?.models.find((model) => model.capabilities.includes("imageGenerate"))?.id ?? DEFAULT_MODEL,');
  source = replace(source, '\t\tmodels: [...SUPPORTED_MODELS],', '\t\tmodels: media ? media.models.filter((model) => model.capabilities.includes("imageGenerate")).map((model) => model.id) : [...SUPPORTED_MODELS],');
  source = replace(source, '\t\t\tprovider: "openrouter",', '\t\t\tprovider: providerId,');
  return replace(source, 'await resolveOpenRouterGenerationRequestContext({\n\t\t\t\tcfg: req.cfg,', 'await resolveOpenRouterGenerationRequestContext({\n\t\t\t\tproviderId,\n\t\t\t\tcfg: req.cfg,');
}

function patchOpenRouterContext(source) {
  source = replace(source, 'async function resolveOpenRouterGenerationRequestContext(params) {', 'async function resolveOpenRouterGenerationRequestContext(params) {\n\tconst providerId = params.providerId ?? "openrouter";');
  source = replace(source, '\t\tprovider: "openrouter",\n\t\tcfg: params.cfg,', '\t\tprovider: providerId,\n\t\tcfg: params.cfg,');
  source = replace(source, 'baseUrl: params.cfg.models?.providers?.openrouter?.baseUrl,', 'baseUrl: params.cfg.models?.providers?.[providerId]?.baseUrl,');
  source = replace(source, 'sanitizeConfiguredModelProviderRequest(params.cfg.models?.providers?.openrouter?.request)', 'sanitizeConfiguredModelProviderRequest(params.cfg.models?.providers?.[providerId]?.request)');
  return replace(source, '\t\tprovider: "openrouter",\n\t\tcapability: params.capability,', '\t\tprovider: providerId,\n\t\tcapability: params.capability,');
}

function patchImageModelDefaults(source) {
  source = replace(source, '\t\tprepareCandidate(candidate, provider) {', `\t\tprepareCandidate(candidate, provider) {
\t\t\tconst mediaModel = params.cfg.models?.providers?.[candidate.provider]?.media?.models.find((model) => model.id === candidate.model && model.capabilities.includes("imageGenerate"));`);
  source = replace(source, '\t\t\t\t\ttimeoutMs: requestedTimeoutMs,', '\t\t\t\t\ttimeoutMs: requestedTimeoutMs ?? mediaModel?.timeoutMs,');
  source = replace(source, '\t\t\t\t\taspectRatio: params.aspectRatio,', '\t\t\t\t\taspectRatio: params.aspectRatio ?? mediaModel?.aspectRatio,');
  source = replace(source, '\t\t\t\t\tresolution: params.resolution ?? inferredResolution,', '\t\t\t\t\tresolution: params.resolution ?? mediaModel?.resolution ?? inferredResolution,');
  return replace(source, '\t\t\t\t\tquality: params.quality,', '\t\t\t\t\tquality: params.quality ?? mediaModel?.quality,');
}

export function patchOpenClawMedia(openclawDir) {
  const pkg = JSON.parse(read(path.join(openclawDir, 'package.json')));
  if (pkg.name !== 'openclaw' || pkg.version !== VERSION) throw new Error(`${PATCH}: requires openclaw@${VERSION}`);
  const dist = path.join(openclawDir, 'dist');
  const edits = [
    [locate(dist, 'zod-schema.core-', ['const ModelProviderSchema = object({']), patchSchema],
    [path.join(dist, 'extensions/openai/index.js'), patchOpenAIRegistration],
    [locate(dist, 'image-generation-provider-', ['function buildOpenAIImageGenerationProvider(']), patchOpenAIFactory],
    [path.join(dist, 'extensions/google/index.js'), patchGoogleRegistration],
    [path.join(dist, 'extensions/google/image-generation-provider.js'), patchGoogleFactory],
    [locate(dist, 'api-', ['function resolveGoogleGenerativeAiHttpRequestConfig(params)']), patchGoogleHttp],
    [path.join(dist, 'extensions/openrouter/index.js'), patchOpenRouterRegistration],
    [locate(dist, 'image-generation-provider-', ['function buildOpenRouterImageGenerationProvider(']), patchOpenRouterFactory],
    [locate(dist, 'generation-request-context-', ['async function resolveOpenRouterGenerationRequestContext(params)']), patchOpenRouterContext],
    [locate(dist, 'runtime-', ['async function generateImage(params, deps = {})']), patchImageModelDefaults],
  ].map(([file, transform]) => {
    const before = read(file);
    return { file, before, after: transform(before) };
  });
  const changed = edits.filter(({ before, after }) => before !== after);
  for (const { file, after } of changed) fs.writeFileSync(file, after);
  return {
    status: changed.length ? 'applied' : 'clean',
    detail: `OpenClaw ${VERSION} strict account media config and native OpenAI/Google/OpenRouter image providers (${changed.length} files)`,
  };
}
