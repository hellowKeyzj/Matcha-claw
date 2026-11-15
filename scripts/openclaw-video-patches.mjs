import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const VERSION = '2026.9.3';
const PATCH = 'native-account-video';
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

function registration(protocol, nativeCall, mediaCall) {
  return `\t\tif (!api.config.models?.providers?.${protocol}?.media?.models.some((model) => model.capabilities.includes("videoGenerate"))) ${nativeCall}
\t\tfor (const [providerId, providerConfig] of Object.entries(api.config.models?.providers ?? {})) {
\t\t\tconst media = providerConfig.media;
\t\t\tif (media?.api !== "${protocol}" || !media.models.some((model) => model.capabilities.includes("videoGenerate"))) continue;
\t\t\t${mediaCall}
\t\t}`;
}

function patchOpenAIVideoRegistration(source) {
  const native = 'api.registerVideoGenerationProvider(buildOpenAIVideoGenerationProvider({ isProviderApiKeyConfigured }));';
  return replace(source, `\t\t${native}`, registration('openai', native,
    'api.registerVideoGenerationProvider(buildOpenAIVideoGenerationProvider({ isProviderApiKeyConfigured }, providerId, media));'));
}

function patchOpenAIVideoFactory(source) {
  source = replace(source, 'function buildOpenAIVideoGenerationProvider({ isProviderApiKeyConfigured }) {', `function buildOpenAIVideoGenerationProvider(modelAuth, providerId = "openai", media) {
\tconst { isProviderApiKeyConfigured } = modelAuth;
\tconst models = media ? media.models.filter((model) => model.capabilities.includes("videoGenerate")).map((model) => model.id) : [DEFAULT_OPENAI_VIDEO_MODEL, "sora-2-pro"];`);
  source = replace(source, `\t\tid: "openai",
\t\tlabel: "OpenAI",
\t\tdefaultModel: DEFAULT_OPENAI_VIDEO_MODEL,
\t\tmodels: [DEFAULT_OPENAI_VIDEO_MODEL, "sora-2-pro"],`, `\t\tid: providerId,
\t\tlabel: media ? providerId : "OpenAI",
\t\tdefaultModel: models[0],
\t\tmodels,`);
  source = replace(source, '\t\tisConfigured: (ctx) => isProviderApiKeyConfigured({\n\t\t\tprovider: "openai",', '\t\tisConfigured: (ctx) => isProviderApiKeyConfigured({\n\t\t\tprovider: providerId,');
  if (!source.includes('\tasync function resolveContext(req) {')) {
    source = replace(source, '\t\t\t\tprovider: "openai",\n\t\t\t\tcfg: req.cfg,', '\t\t\t\tprovider: providerId,\n\t\t\t\tcfg: req.cfg,');
    source = replace(source, '\t\t\tconst providerConfig = req.cfg.models?.providers?.openai;', '\t\t\tconst providerConfig = req.cfg.models?.providers?.[providerId];');
    source = replace(source, '\t\t\t\tbaseUrl: resolveConfiguredOpenAIBaseUrl(req.cfg),', '\t\t\t\tbaseUrl: media ? providerConfig?.baseUrl : resolveConfiguredOpenAIBaseUrl(req.cfg),');
    source = replace(source, '\t\t\t\tprovider: "openai",\n\t\t\t\tcapability: "video",', '\t\t\t\tprovider: providerId,\n\t\t\t\tcapability: "video",');
  }
  source = replace(source, '\t\t\tconst model = normalizeOptionalString(req.model) ?? DEFAULT_OPENAI_VIDEO_MODEL;', '\t\t\tconst model = normalizeOptionalString(req.model) ?? models[0];');
  const authSource = `\t\t\tconst { resolveApiKeyForProvider } = await import("./plugin-sdk/provider-auth-runtime.js");
\t\t\tconst auth = await resolveApiKeyForProvider({
\t\t\t\tprovider: providerId,
\t\t\t\tcfg: req.cfg,
\t\t\t\tagentDir: req.agentDir,
\t\t\t\tstore: req.authStore,
\t\t\t\tmodelApi: "openai-responses"
\t\t\t});
\t\t\tif (!auth.apiKey || auth.mode !== void 0 && auth.mode !== "api-key") throw new Error("OpenAI API key missing");`;
  const requestSource = `\t\t\tconst deadline = createProviderOperationDeadline({
\t\t\t\ttimeoutMs: req.timeoutMs,
\t\t\t\tlabel: "OpenAI video generation"
\t\t\t});
\t\t\tconst providerConfig = req.cfg.models?.providers?.[providerId];
\t\t\tconst { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
\t\t\t\tbaseUrl: media ? providerConfig?.baseUrl : resolveConfiguredOpenAIBaseUrl(req.cfg),
\t\t\t\tdefaultBaseUrl: DEFAULT_OPENAI_VIDEO_BASE_URL,
\t\t\t\trequest: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
\t\t\t\tdefaultHeaders: { Authorization: \`Bearer \${auth.apiKey}\` },
\t\t\t\tprovider: providerId,
\t\t\t\tcapability: "video",
\t\t\t\ttransport: "http"
\t\t\t});`;
  source = replace(source, authSource, '\t\t\tconst context = await resolveContext(req);');
  source = replace(source, requestSource, '\t\t\tconst { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy, deadline } = context;');
  source = replace(source, `\tconst models = media ? media.models.filter((model) => model.capabilities.includes("videoGenerate")).map((model) => model.id) : [DEFAULT_OPENAI_VIDEO_MODEL, "sora-2-pro"];
\treturn {`, `\tconst models = media ? media.models.filter((model) => model.capabilities.includes("videoGenerate")).map((model) => model.id) : [DEFAULT_OPENAI_VIDEO_MODEL, "sora-2-pro"];
\tasync function resolveContext(req) {
${authSource.replace(/^\t/gm, '')}
\t\tconst { createProviderOperationDeadline, resolveProviderHttpRequestConfig, sanitizeConfiguredModelProviderRequest } = await import("./plugin-sdk/provider-http.js");
${requestSource.replace(/^\t/gm, '').replace('timeoutMs: req.timeoutMs,', 'timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,')}
\t\treturn { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy, deadline };
\t}
\tasync function readVideo(req) {
\t\tconst videoId = normalizeOptionalString(req.videoId);
\t\tif (!videoId) throw new Error("OpenAI video id missing");
\t\tconst context = await resolveContext(req);
\t\tconst { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy, deadline } = context;
\t\tconst { assertOkOrThrowHttpError, createProviderOperationTimeoutResolver, fetchWithTimeoutGuarded, readProviderJsonObjectResponse } = await import("./plugin-sdk/provider-http.js");
\t\tconst timeoutMs = createProviderOperationTimeoutResolver({ deadline, defaultTimeoutMs: DEFAULT_TIMEOUT_MS });
\t\tconst { response, release } = await fetchWithTimeoutGuarded(\`\${baseUrl}/videos/\${encodeURIComponent(videoId)}\`, { method: "GET", headers }, timeoutMs(), fetch, {
\t\t\t...allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {},
\t\t\t...dispatcherPolicy ? { dispatcherPolicy } : {},
\t\t\tauditContext: "openai-video-status"
\t\t});
\t\tlet payload;
\t\ttry {
\t\t\tawait assertOkOrThrowHttpError(response, "OpenAI video status request failed", { bodyTimeoutMs: timeoutMs, requestHeaders: headers });
\t\t\tpayload = await readProviderJsonObjectResponse(response, "OpenAI video status request failed", { timeoutMs, requestHeaders: headers });
\t\t} finally {
\t\t\tawait release();
\t\t}
\t\tconst failureMessage = readOpenAIVideoFailureMessage(payload);
\t\tif (failureMessage) {
\t\t\tconst error = new Error(failureMessage);
\t\t\terror.name = "VideoGenerationFailedError";
\t\t\tthrow error;
\t\t}
\t\tif (payload.status === "queued") return { status: "queued" };
\t\tif (payload.status === "in_progress") return { status: "running" };
\t\tif (payload.status !== "completed") throw new Error("OpenAI video status response malformed");
\t\tconst { resolveGeneratedMediaMaxBytes } = await import("./plugin-sdk/media-generation-runtime.js");
\t\treturn {
\t\t\tstatus: "completed",
\t\t\tvideos: [await downloadOpenAIVideo({ ...context, providerId, videoId, fetchFn: fetch, maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "video") })],
\t\t\tmodel: payload.model ?? normalizeOptionalString(req.model) ?? models[0],
\t\t\tmetadata: { videoId, status: payload.status, seconds: payload.seconds, size: payload.size }
\t\t};
\t}
\treturn {`);
  source = replace(source, '\t\tmodels,\n\t\tisConfigured:', '\t\tmodels,\n\t\t...media ? { readVideo } : {},\n\t\tisConfigured:');
  source = replace(source, `\t\t\t\tif (!videoId) throw new Error("OpenAI video generation response missing video id");
\t\t\t\tconst completed`, `\t\t\t\tif (!videoId) throw new Error("OpenAI video generation response missing video id");
\t\t\t\tawait req.onJobSubmitted?.({ provider: providerId, model, videoId });
\t\t\t\tconst completed`);
  source = replace(source, '\t\t\tconst { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy, deadline } = context;', `\t\t\tconst { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy, deadline } = context;
\t\t\tconst rethrowGenerationError = (error) => {
\t\t\t\tconst deadlineMessage = \`\${deadline.label} timed out\${typeof deadline.timeoutMs === "number" ? \` after \${deadline.timeoutMs}ms\` : ""}\`;
\t\t\t\tif (error?.name === "TimeoutError" || error?.name === "AbortError" || error?.message === deadlineMessage) {
\t\t\t\t\tconst timeoutError = new Error("OpenAI video generation timed out", { cause: error });
\t\t\t\t\ttimeoutError.name = "VideoGenerationTimeoutError";
\t\t\t\t\tthrow timeoutError;
\t\t\t\t}
\t\t\t\tthrow error;
\t\t\t};`);
  source = replace(source, '\t\t\tconst model = normalizeOptionalString(req.model) ?? models[0];', `\t\t\tconst requestTimeoutMs = createProviderOperationTimeoutResolver({ deadline, defaultTimeoutMs: DEFAULT_TIMEOUT_MS });
\t\t\tconst onRequestTimeout = () => new DOMException("OpenAI video generation response timed out", "TimeoutError");
\t\t\ttry {
\t\t\tconst model = normalizeOptionalString(req.model) ?? models[0];`);
  source = replace(source, '\t\t\t\tawait assertOkOrThrowHttpError(response, "OpenAI video generation failed");', '\t\t\t\tawait assertOkOrThrowHttpError(response, "OpenAI video generation failed", { bodyTimeoutMs: requestTimeoutMs, onBodyTimeout: onRequestTimeout, requestHeaders: headers });');
  source = replace(source, '\t\t\t\tconst submitted = await readProviderJsonResponse(response, "OpenAI video generation failed");', '\t\t\t\tconst submitted = await readProviderJsonResponse(response, "OpenAI video generation failed", { timeoutMs: requestTimeoutMs, onTimeout: onRequestTimeout, requestHeaders: headers });');
  source = replace(source, `\t\t\t} finally {
\t\t\t\tawait release();
\t\t\t}
\t\t}
\t};`, `\t\t\t} finally {
\t\t\t\tawait release();
\t\t\t}
\t\t\t} catch (error) {
\t\t\t\trethrowGenerationError(error);
\t\t\t}
\t\t}
\t};`);
  source = replace(source, `\tconst { createProviderOperationDeadline, pollProviderOperationJson } = operations;
\tconst deadline = createProviderOperationDeadline({
\t\ttimeoutMs: params.timeoutMs,
\t\tlabel: \`OpenAI video generation task \${params.videoId}\`
\t});`, `\tconst { pollProviderOperationJson } = operations;
\tconst deadline = params.deadline;`);
  source = replace(source, '\t\tmaxAttempts: MAX_POLL_ATTEMPTS,', '\t\tmaxAttempts: Math.max(MAX_POLL_ATTEMPTS, Math.ceil((deadline.timeoutMs ?? 0) / POLL_INTERVAL_MS) + 1),');
  source = replace(source, `\t\t\t\t\theaders,
\t\t\t\t\ttimeoutMs: resolveProviderOperationTimeoutMs({
\t\t\t\t\t\tdeadline,
\t\t\t\t\t\tdefaultTimeoutMs: DEFAULT_TIMEOUT_MS
\t\t\t\t\t}),
\t\t\t\t\tbaseUrl,`, '\t\t\t\t\theaders,\n\t\t\t\t\tdeadline,\n\t\t\t\t\tbaseUrl,');
  source = replace(source, `\t\t\t\t}, {
\t\t\t\t\tcreateProviderOperationDeadline,
\t\t\t\t\tpollProviderOperationJson
\t\t\t\t});`, '\t\t\t\t}, { pollProviderOperationJson });');
  source = replace(source, 'assertOkOrThrowHttpError, createProviderOperationDeadline, createProviderOperationTimeoutResolver, pollProviderOperationJson, postMultipartRequest, readProviderJsonResponse, resolveProviderOperationTimeoutMs, resolveProviderHttpRequestConfig, sanitizeConfiguredModelProviderRequest', 'assertOkOrThrowHttpError, createProviderOperationTimeoutResolver, pollProviderOperationJson, postMultipartRequest, readProviderJsonResponse, resolveProviderOperationTimeoutMs');
  source = replace(source, 'videos: [await downloadOpenAIVideo({\n\t\t\t\t\t\tvideoId,', 'videos: [await downloadOpenAIVideo({\n\t\t\t\t\t\tproviderId,\n\t\t\t\t\t\tvideoId,');
  source = replace(source, `\t\t\t\t\t\theaders,
\t\t\t\t\t\ttimeoutMs: createProviderOperationTimeoutResolver({
\t\t\t\t\t\t\tdeadline,
\t\t\t\t\t\t\tdefaultTimeoutMs: DEFAULT_TIMEOUT_MS
\t\t\t\t\t\t}),
\t\t\t\t\t\tbaseUrl,`, '\t\t\t\t\t\theaders,\n\t\t\t\t\t\tdeadline,\n\t\t\t\t\t\tbaseUrl,');
  const downloadSource = `async function downloadOpenAIVideo(params) {
\tconst { downloadGeneratedVideoAsset } = await import("./plugin-sdk/media-generation-runtime.js");
\tconst url = new URL(\`\${params.baseUrl}/videos/\${params.videoId}/content\`);
\turl.searchParams.set("variant", "video");
\treturn await downloadGeneratedVideoAsset({
\t\turl: url.toString(),
\t\ttimeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
\t\tdefaultTimeoutMs: DEFAULT_TIMEOUT_MS,
\t\tfetchFn: params.fetchFn,
\t\tprovider: "openai",
\t\tlabel: "OpenAI generated video download",
\t\trequestFailedMessage: "OpenAI video download failed",
\t\tmaxBytes: params.maxBytes,
\t\tvalidateBinaryResponse: true,
\t\tfetchResponse: async ({ deadline }) => await fetchOpenAIVideoDownload({
\t\t\turl: url.toString(),
\t\t\tinit: {
\t\t\t\tmethod: "GET",
\t\t\t\theaders: new Headers({
\t\t\t\t\t...Object.fromEntries(params.headers.entries()),
\t\t\t\t\tAccept: "application/binary"
\t\t\t\t})
\t\t\t},
\t\t\tdeadline,
\t\t\tfetchFn: params.fetchFn,
\t\t\tallowPrivateNetwork: params.allowPrivateNetwork,
\t\t\tdispatcherPolicy: params.dispatcherPolicy
\t\t})
\t});
}`;
  const patchedDownloadSource = `async function downloadOpenAIVideo(params) {
\tconst { createProviderOperationTimeoutResolver, readProviderBinaryResponse } = await import("./plugin-sdk/provider-http.js");
\tconst url = new URL(\`\${params.baseUrl}/videos/\${encodeURIComponent(params.videoId)}/content\`);
\turl.searchParams.set("variant", "video");
\tconst { response, release } = await fetchOpenAIVideoDownload({
\t\t...params,
\t\turl: url.toString(),
\t\tinit: {
\t\t\tmethod: "GET",
\t\t\theaders: new Headers({
\t\t\t\t...Object.fromEntries(params.headers.entries()),
\t\t\t\tAccept: "application/binary"
\t\t\t})
\t\t}
\t});
\ttry {
\t\tconst mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
\t\tconst buffer = await readProviderBinaryResponse(response, "OpenAI generated video download", "video", {
\t\t\tmaxBytes: params.maxBytes,
\t\t\ttimeoutMs: createProviderOperationTimeoutResolver({ deadline: params.deadline, defaultTimeoutMs: DEFAULT_TIMEOUT_MS }),
\t\t\tonTimeout: () => new DOMException("OpenAI generated video download timed out", "TimeoutError"),
\t\t\tonOverflow: ({ maxBytes }) => new Error(\`OpenAI generated video download exceeds \${maxBytes} bytes\`)
\t\t});
\t\treturn { buffer, mimeType, fileName: \`video-1.\${extensionForMime(mimeType)?.slice(1) ?? "mp4"}\` };
\t} finally {
\t\tawait release();
\t}
}`;
  source = replace(source, downloadSource, patchedDownloadSource);
  source = replace(source, 'executeProviderOperationWithRetry, fetchProviderDownloadResponse, fetchWithTimeoutGuarded', 'executeProviderOperationWithRetry, fetchProviderOperationResponse, fetchWithTimeoutGuarded');
  source = replace(source, `\tconst timeoutMs = createProviderOperationTimeoutResolver({
\t\tdeadline: params.deadline,
\t\tdefaultTimeoutMs: params.deadline.timeoutMs ?? DEFAULT_TIMEOUT_MS
\t});`, `\tconst timeoutMs = createProviderOperationTimeoutResolver({
\t\tdeadline: params.deadline,
\t\tdefaultTimeoutMs: DEFAULT_TIMEOUT_MS
\t});`);
  source = replace(source, `response: await fetchProviderDownloadResponse({
\t\t\turl: params.url,
\t\t\tinit: params.init,
\t\t\tdeadline: params.deadline,`, `response: await fetchProviderOperationResponse({
\t\t\tstage: "download",
\t\t\turl: params.url,
\t\t\tinit: params.init,
\t\t\ttimeoutMs,`);
  source = replace(source, '\t\t\tprovider: "openai",\n\t\t\trequestFailedMessage: "OpenAI video download failed"', '\t\t\tprovider: params.providerId,\n\t\t\trequestFailedMessage: "OpenAI video download failed"');
  return replace(source, '\t\tprovider: "openai",\n\t\tstage: "download",', '\t\tprovider: params.providerId,\n\t\tstage: "download",');
}

function patchGoogleVideoRegistration(source) {
  source = replace(source, `let googleMusicGenerationProviderPromise = null;
let googleVideoGenerationProviderPromise = null;
async function loadGoogleImageGenerationProvider(`, `let googleMusicGenerationProviderPromise = null;
async function loadGoogleImageGenerationProvider(`);
  source = replace(source, `\treturn await googleMusicGenerationProviderPromise;
}
async function loadGoogleVideoGenerationProvider() {
\tif (!googleVideoGenerationProviderPromise) googleVideoGenerationProviderPromise = import("./video-generation-provider.js").then((mod) => mod.buildGoogleVideoGenerationProvider());
\treturn await googleVideoGenerationProviderPromise;
}
async function loadGoogleRequiredMediaUnderstandingProvider(`, `\treturn await googleMusicGenerationProviderPromise;
}
async function loadGoogleRequiredMediaUnderstandingProvider(`);
  source = replace(source, `function createLazyGoogleVideoGenerationProvider() {
\treturn {
\t\t...createGoogleVideoGenerationProviderMetadata(),
\t\tgenerateVideo: async (...args) => await (await loadGoogleVideoGenerationProvider()).generateVideo(...args)
\t};
}`, `function createLazyGoogleVideoGenerationProvider(providerId = "google", media) {
\tlet providerPromise;
\treturn {
\t\t...createGoogleVideoGenerationProviderMetadata(providerId, media),
\t\tgenerateVideo: async (...args) => {
\t\t\tproviderPromise ??= import("./video-generation-provider.js").then((mod) => mod.buildGoogleVideoGenerationProvider(providerId, media));
\t\t\treturn await (await providerPromise).generateVideo(...args);
\t\t}
\t};
}`);
  return replace(source, '\t\tapi.registerVideoGenerationProvider(createLazyGoogleVideoGenerationProvider());',
    registration('google', 'api.registerVideoGenerationProvider(createLazyGoogleVideoGenerationProvider());',
      'api.registerVideoGenerationProvider(createLazyGoogleVideoGenerationProvider(providerId, media));'));
}

function patchGoogleVideoMetadata(source) {
  return replace(source, `function createGoogleVideoGenerationProviderMetadata() {
\treturn {
\t\tid: "google",
\t\tlabel: "Google",
\t\tdefaultModel: DEFAULT_GOOGLE_VIDEO_MODEL,
\t\tmodels: [
\t\t\tDEFAULT_GOOGLE_VIDEO_MODEL,
\t\t\t"veo-3.1-generate-preview",
\t\t\t"veo-3.1-lite-generate-preview"
\t\t],
\t\tisConfigured: isGoogleProviderConfigured,`, `function createGoogleVideoGenerationProviderMetadata(providerId = "google", media) {
\tconst models = media ? media.models.filter((model) => model.capabilities.includes("videoGenerate")).map((model) => model.id) : [
\t\tDEFAULT_GOOGLE_VIDEO_MODEL,
\t\t"veo-3.1-generate-preview",
\t\t"veo-3.1-lite-generate-preview"
\t];
\treturn {
\t\tid: providerId,
\t\tlabel: media ? providerId : "Google",
\t\tdefaultModel: models[0],
\t\tmodels,
\t\tisConfigured: media ? (ctx) => isProviderApiKeyConfigured({ ...ctx, provider: providerId }) : isGoogleProviderConfigured,`);
}

function patchGoogleVideoFactory(source) {
  source = replace(source, '//#region extensions/google/video-generation-provider.ts', `import { resolveGoogleGenerativeAiHttpRequestConfig } from "./api.js";
import { sanitizeConfiguredModelProviderRequest } from "../../plugin-sdk/provider-http.js";
//#region extensions/google/video-generation-provider.ts`);
  source = replace(source, '\tconst baseUrl = resolveGoogleVideoRestBaseUrl(params.configuredBaseUrl);', '\tconst baseUrl = params.restBaseUrl ?? resolveGoogleVideoRestBaseUrl(params.configuredBaseUrl);');
  source = replace(source, '\tif (!url.searchParams.has("key")) url.searchParams.set("key", params.apiKey);', '\tif ((!params.providerId || url.origin === new URL(params.configuredBaseUrl).origin) && !url.searchParams.has("key")) url.searchParams.set("key", params.apiKey);');
  source = replace(source, `\tconst downloadUrl = resolveGoogleGeneratedVideoDownloadUrl({
\t\turi: params.uri,`, `\tconst downloadUrl = resolveGoogleGeneratedVideoDownloadUrl({
\t\tproviderId: params.providerId,
\t\turi: params.uri,`);
  source = replace(source, '\t\tprovider: "google",\n\t\tstage: "download",', '\t\tprovider: params.providerId ?? "google",\n\t\tstage: "download",');
  source = replace(source, `\t\t\t\turl: downloadUrl,
\t\t\t\ttimeoutMs: params.timeoutMs`, `\t\t\t\turl: downloadUrl,
\t\t\t\t...params.providerId && new URL(downloadUrl).origin === new URL(params.configuredBaseUrl).origin ? {
\t\t\t\t\tinit: { headers: params.headers },
\t\t\t\t\tmaxRedirects: 0
\t\t\t\t} : {},
\t\t\t\tdispatcherPolicy: params.dispatcherPolicy,
\t\t\t\tpolicy: params.allowPrivateNetwork ? { allowPrivateNetwork: true } : void 0,
\t\t\t\ttimeoutMs: params.timeoutMs`);
  source = replace(source, '\treturn Array.isArray(generatedSamples) ? generatedSamples : [];', `\treturn Array.isArray(generatedSamples) ? generatedSamples.map((entry) => {
\t\tconst video = entry.video;
\t\treturn video ? {
\t\t\t...entry,
\t\t\tvideo: {
\t\t\t\t...video,
\t\t\t\tvideoBytes: video.videoBytes ?? video.encodedVideo,
\t\t\t\tmimeType: video.mimeType ?? video.encoding
\t\t\t}
\t\t} : entry;
\t}) : [];`);
  source = replace(source, '\t\tprovider: "google",\n\t\tstage: params.stage,', '\t\tprovider: params.providerId ?? "google",\n\t\tstage: params.stage,');
  source = replace(source, '\t\t\t\t\tsignal: controller.signal', `\t\t\t\t\tdispatcherPolicy: params.dispatcherPolicy,
\t\t\t\t\tpolicy: params.allowPrivateNetwork ? { allowPrivateNetwork: true } : void 0,
\t\t\t\t\tsignal: controller.signal`);
  source = replace(source, `\t\tmethod: "POST",
\t\theaders: params.headers,
\t\tdeadline: params.deadline,
\t\tstage: "create",`, `\t\tmethod: "POST",
\t\theaders: params.headers,
\t\tdeadline: params.deadline,
\t\tproviderId: params.providerId,
\t\tdispatcherPolicy: params.dispatcherPolicy,
\t\tallowPrivateNetwork: params.allowPrivateNetwork,
\t\tstage: "create",`);
  source = replace(source, '\t\t\tinstances: [{ prompt: params.prompt }],', `\t\t\tinstances: [{
\t\t\t\tprompt: params.prompt,
\t\t\t\t...params.image ? { image: {
\t\t\t\t\tbytesBase64Encoded: params.image.imageBytes,
\t\t\t\t\tmimeType: params.image.mimeType
\t\t\t\t} } : {},
\t\t\t\t...params.video ? { video: {
\t\t\t\t\tencodedVideo: params.video.videoBytes,
\t\t\t\t\tencoding: params.video.mimeType
\t\t\t\t} } : {}
\t\t\t}],`);
  source = replace(source, `\t\t\tmethod: "GET",
\t\t\theaders: params.headers,
\t\t\tdeadline: params.deadline,
\t\t\tstage: "poll"`, `\t\t\tmethod: "GET",
\t\t\theaders: params.headers,
\t\t\tdeadline: params.deadline,
\t\t\tproviderId: params.providerId,
\t\t\tdispatcherPolicy: params.dispatcherPolicy,
\t\t\tallowPrivateNetwork: params.allowPrivateNetwork,
\t\t\tstage: "poll"`);
  source = replace(source, '\tfor (let attempt = 0; !(operation.done ?? false); attempt += 1) {', `\tconst submittedName = normalizeOptionalString(operation.name);
\tif (submittedName) await params.onJobSubmitted?.({ provider: params.providerId ?? "google", model: params.model, videoId: submittedName });
\tfor (let attempt = 0; !(operation.done ?? false); attempt += 1) {`);
  source = replace(source, `\tconst error = operation.error;
\tif (error) throw new Error(JSON.stringify(error));
\treturn operation;`, `\tconst error = operation.error;
\tif (error) throw new Error(JSON.stringify(error));
\treturn { operation, generatedVideos: extractGeneratedVideos(operation) };`);
  source = replace(source, `function buildGoogleVideoGenerationProvider() {
\treturn {
\t\t...createGoogleVideoGenerationProviderMetadata(),`, `function resolveGoogleVideoRequestConfig(req, apiKey, providerId, media) {
\tif (media) {
\t\tconst request = resolveGoogleGenerativeAiHttpRequestConfig({
\t\t\tapiKey,
\t\t\tproviderId,
\t\t\tbaseUrl: req.cfg?.models?.providers?.[providerId]?.baseUrl,
\t\t\trequest: sanitizeConfiguredModelProviderRequest(req.cfg?.models?.providers?.[providerId]?.request),
\t\t\tcapability: "video",
\t\t\ttransport: "http"
\t\t});
\t\treturn { ...request, providerId, configuredBaseUrl: request.baseUrl };
\t}
\tconst configuredBaseUrl = resolveConfiguredGoogleVideoBaseUrl(req);
\tconst baseUrl = resolveGoogleVideoRestBaseUrl(configuredBaseUrl);
\treturn {
\t\tbaseUrl,
\t\tconfiguredBaseUrl,
\t\theaders: {
\t\t\t...parseGeminiAuth(apiKey).headers,
\t\t\t...resolveGoogleApiClientHeaders({ baseUrl, api: "google-generative-ai", capability: "video", transport: "http" })
\t\t}
\t};
}
async function generateGoogleVideoViaSdk(params) {
\tconst client = createGoogleGenAI({
\t\tapiKey: params.apiKey,
\t\thttpOptions: {
\t\t\t...params.configuredBaseUrl ? { baseUrl: params.configuredBaseUrl } : {},
\t\t\ttimeout: resolveProviderOperationTimeoutMs({ deadline: params.deadline, defaultTimeoutMs: DEFAULT_TIMEOUT_MS })
\t\t}
\t});
\tlet operation;
\ttry {
\t\toperation = await client.models.generateVideos({
\t\t\tmodel: params.model,
\t\t\tprompt: params.prompt,
\t\t\timage: params.image,
\t\t\tvideo: params.video,
\t\t\tconfig: {
\t\t\t\t...typeof params.durationSeconds === "number" ? { durationSeconds: params.durationSeconds } : {},
\t\t\t\t...params.aspectRatio ? { aspectRatio: params.aspectRatio } : {},
\t\t\t\t...params.resolution ? { resolution: params.resolution } : {}
\t\t\t}
\t\t});
\t} catch (error) {
\t\tif (params.hasReferenceInputs || extractGoogleApiErrorCode(error) !== 404) throw error;
\t\treturn await generateGoogleVideoViaRest(params);
\t}
\tif (operation.name) await params.onJobSubmitted?.({ provider: params.providerId ?? "google", model: params.model, videoId: operation.name });
\tfor (let attempt = 0; !(operation.done ?? false); attempt += 1) {
\t\tif (attempt >= MAX_POLL_ATTEMPTS) throw new Error("Google video generation did not finish in time");
\t\tawait waitProviderOperationPollInterval({ deadline: params.deadline, pollIntervalMs: POLL_INTERVAL_MS });
\t\tresolveProviderOperationTimeoutMs({ deadline: params.deadline, defaultTimeoutMs: DEFAULT_TIMEOUT_MS });
\t\toperation = await executeProviderOperationWithRetry({
\t\t\tprovider: "google",
\t\t\tstage: "poll",
\t\t\toperation: () => client.operations.getVideosOperation({ operation })
\t\t});
\t}
\tif (operation.error) throw new Error(JSON.stringify(operation.error));
\tconst generatedVideos = extractGeneratedVideos(operation);
\tif (!params.hasReferenceInputs && !operation.name && generatedVideos.length === 0) {
\t\tconst fallback = await generateGoogleVideoViaRest(params);
\t\treturn { operation, generatedVideos: fallback.generatedVideos };
\t}
\treturn { operation, generatedVideos };
}
function buildGoogleVideoGenerationProvider(providerId = "google", media) {
\tconst metadata = createGoogleVideoGenerationProviderMetadata(providerId, media);
\treturn {
\t\t...metadata,`);
  source = replace(source, '\t\t\t\tprovider: "google",\n\t\t\t\tcfg: req.cfg,', '\t\t\t\tprovider: providerId,\n\t\t\t\tcfg: req.cfg,');
  source = replace(source, `\t\t\tconst configuredBaseUrl = resolveConfiguredGoogleVideoBaseUrl(req);
\t\t\tconst restBaseUrl = resolveGoogleVideoRestBaseUrl(configuredBaseUrl);
\t\t\tconst authHeaders = {
\t\t\t\t...parseGeminiAuth(apiKey).headers,
\t\t\t\t...resolveGoogleApiClientHeaders({
\t\t\t\t\tbaseUrl: restBaseUrl,
\t\t\t\t\tapi: "google-generative-ai",
\t\t\t\t\tcapability: "video",
\t\t\t\t\ttransport: "http"
\t\t\t\t})
\t\t\t};`, `\t\t\tconst requestConfig = resolveGoogleVideoRequestConfig(req, apiKey, providerId, media);
\t\t\tconst { baseUrl: restBaseUrl, configuredBaseUrl } = requestConfig;`);
  source = replace(source, '\t\t\tconst model = normalizeOptionalString(req.model) || "veo-3.1-fast-generate-preview";', '\t\t\tconst model = normalizeOptionalString(req.model) || metadata.defaultModel;');
  source = replace(source, `\t\t\tconst client = createGoogleGenAI({
\t\t\t\tapiKey,
\t\t\t\thttpOptions: {
\t\t\t\t\t...configuredBaseUrl ? { baseUrl: configuredBaseUrl } : {},
\t\t\t\t\ttimeout: resolveProviderOperationTimeoutMs({
\t\t\t\t\t\tdeadline,
\t\t\t\t\t\tdefaultTimeoutMs: DEFAULT_TIMEOUT_MS
\t\t\t\t\t})
\t\t\t\t}
\t\t\t});
\t\t\tlet usedRestFallback = false;
\t\t\tlet operation;
\t\t\ttry {
\t\t\t\toperation = await client.models.generateVideos({
\t\t\t\t\tmodel,
\t\t\t\t\tprompt: req.prompt,
\t\t\t\t\timage: resolveInputImage(req),
\t\t\t\t\tvideo: resolveInputVideo(req),
\t\t\t\t\tconfig: {
\t\t\t\t\t\t...typeof durationSeconds === "number" ? { durationSeconds } : {},
\t\t\t\t\t\t...aspectRatio ? { aspectRatio } : {},
\t\t\t\t\t\t...resolution ? { resolution } : {}
\t\t\t\t\t}
\t\t\t\t});
\t\t\t} catch (error) {
\t\t\t\tif (hasReferenceInputs || extractGoogleApiErrorCode(error) !== 404) throw error;
\t\t\t\tusedRestFallback = true;
\t\t\t\toperation = await generateGoogleVideoViaRest({
\t\t\t\t\tbaseUrl: restBaseUrl,
\t\t\t\t\theaders: authHeaders,
\t\t\t\t\tdeadline,
\t\t\t\t\tmodel,
\t\t\t\t\tprompt: req.prompt,
\t\t\t\t\tdurationSeconds,
\t\t\t\t\taspectRatio,
\t\t\t\t\tresolution
\t\t\t\t});
\t\t\t}
\t\t\tif (!usedRestFallback) {
\t\t\t\tlet sdkOperation = operation;
\t\t\t\tfor (let attempt = 0; !(sdkOperation.done ?? false); attempt += 1) {
\t\t\t\t\tif (attempt >= MAX_POLL_ATTEMPTS) throw new Error("Google video generation did not finish in time");
\t\t\t\t\tawait waitProviderOperationPollInterval({
\t\t\t\t\t\tdeadline,
\t\t\t\t\t\tpollIntervalMs: POLL_INTERVAL_MS
\t\t\t\t\t});
\t\t\t\t\tresolveProviderOperationTimeoutMs({
\t\t\t\t\t\tdeadline,
\t\t\t\t\t\tdefaultTimeoutMs: DEFAULT_TIMEOUT_MS
\t\t\t\t\t});
\t\t\t\t\tsdkOperation = await executeProviderOperationWithRetry({
\t\t\t\t\t\tprovider: "google",
\t\t\t\t\t\tstage: "poll",
\t\t\t\t\t\toperation: () => client.operations.getVideosOperation({ operation: sdkOperation })
\t\t\t\t\t});
\t\t\t\t}
\t\t\t\toperation = sdkOperation;
\t\t\t}
\t\t\tconst finalOperation = operation;
\t\t\tif (finalOperation.error) throw new Error(JSON.stringify(finalOperation.error));
\t\t\tlet generatedVideos = extractGeneratedVideos(operation);
\t\t\tif (generatedVideos.length === 0 && !hasReferenceInputs && !usedRestFallback) {
\t\t\t\toperation = await generateGoogleVideoViaRest({
\t\t\t\t\tbaseUrl: restBaseUrl,
\t\t\t\t\theaders: authHeaders,
\t\t\t\t\tdeadline,
\t\t\t\t\tmodel,
\t\t\t\t\tprompt: req.prompt,
\t\t\t\t\tdurationSeconds,
\t\t\t\t\taspectRatio,
\t\t\t\t\tresolution
\t\t\t\t});
\t\t\t\tgeneratedVideos = extractGeneratedVideos(operation);
\t\t\t}`, `\t\t\tconst generationRequest = {
\t\t\t\t...requestConfig,
\t\t\t\tonJobSubmitted: req.onJobSubmitted,
\t\t\t\tapiKey,
\t\t\t\tdeadline,
\t\t\t\tmodel,
\t\t\t\tprompt: req.prompt,
\t\t\t\timage: resolveInputImage(req),
\t\t\t\tvideo: resolveInputVideo(req),
\t\t\t\thasReferenceInputs,
\t\t\t\tdurationSeconds,
\t\t\t\taspectRatio,
\t\t\t\tresolution
\t\t\t};
\t\t\tconst { operation: finalOperation, generatedVideos } = media ? await generateGoogleVideoViaRest(generationRequest) : await generateGoogleVideoViaSdk(generationRequest);`);
  for (const call of ['directDownload', 'fileDownload']) {
    source = replace(source, `const ${call} = await downloadGeneratedVideoFromUri({`, `const ${call} = await downloadGeneratedVideoFromUri({
\t\t\t\t\t\t...requestConfig,`);
  }
  return replace(source, 'uri: resolveGoogleGeneratedVideoFileDownloadUrl({', `uri: resolveGoogleGeneratedVideoFileDownloadUrl({
\t\t\t\t\t\t\trestBaseUrl,`);
}

function patchOpenRouterVideoRegistration(source) {
  const native = 'api.registerVideoGenerationProvider(buildOpenRouterVideoGenerationProvider());';
  return replace(source, `\t\t${native}`, registration('openrouter', native,
    'api.registerVideoGenerationProvider(buildOpenRouterVideoGenerationProvider(providerId, media));'));
}

function patchOpenRouterVideoFactory(source) {
  source = replace(source, 'function buildOpenRouterVideoGenerationProvider() {', `function buildOpenRouterVideoGenerationProvider(providerId = "openrouter", media) {
\tconst models = media ? media.models.filter((model) => model.capabilities.includes("videoGenerate")).map((model) => model.id) : [DEFAULT_MODEL];`);
  source = replace(source, `\t\tid: "openrouter",
\t\tlabel: "OpenRouter",
\t\tdefaultModel: DEFAULT_MODEL,
\t\tmodels: [DEFAULT_MODEL],`, `\t\tid: providerId,
\t\tlabel: media ? providerId : "OpenRouter",
\t\tdefaultModel: models[0],
\t\tmodels,`);
  source = replace(source, '\t\tisConfigured: (ctx) => isProviderApiKeyConfigured({\n\t\t\tprovider: "openrouter",', '\t\tisConfigured: (ctx) => isProviderApiKeyConfigured({\n\t\t\tprovider: providerId,');
  source = replace(source, '\t\t\tconst model = normalizeOptionalString(req.model) ?? DEFAULT_MODEL;', '\t\t\tconst model = normalizeOptionalString(req.model) ?? models[0];');
  source = replace(source, '\t\t\t\tconst pollingUrl = normalizeOptionalString(submitted.polling_url);', `\t\t\t\tif (jobId) await req.onJobSubmitted?.({ provider: providerId, model, videoId: jobId });
\t\t\t\tconst pollingUrl = normalizeOptionalString(submitted.polling_url);`);
  return replace(source, 'await resolveOpenRouterGenerationRequestContext({\n\t\t\t\tcfg: req.cfg,', 'await resolveOpenRouterGenerationRequestContext({\n\t\t\t\tproviderId,\n\t\t\t\tcfg: req.cfg,');
}

function patchOpenRouterVideoCapabilities(source) {
  source = replace(source, 'function resolveOpenRouterVideoCatalogRequest(params) {', 'function resolveOpenRouterVideoCatalogRequest(params, providerId = "openrouter") {');
  source = replace(source, '\t\t\tprovider: "openrouter",\n\t\t\tcapability: "video",', '\t\t\tprovider: providerId,\n\t\t\tcapability: "video",');
  source = replace(source, '\t\tprovider: "openrouter",\n\t\tcfg: ctx.cfg,', '\t\tprovider: ctx.provider,\n\t\tcfg: ctx.cfg,');
  source = replace(source, `\t\tapiKey: auth.apiKey,
\t\tbaseUrl: ctx.cfg?.models?.providers?.openrouter?.baseUrl,
\t\trequest: ctx.cfg?.models?.providers?.openrouter?.request
\t});`, `\t\tapiKey: auth.apiKey,
\t\tbaseUrl: ctx.cfg?.models?.providers?.[ctx.provider]?.baseUrl,
\t\trequest: ctx.cfg?.models?.providers?.[ctx.provider]?.request
\t}, ctx.provider);`);
  source = replace(source, '\t\tkeyParts: [\n\t\t\t"openrouter",', '\t\tkeyParts: [\n\t\t\tparams.providerId ?? "openrouter",');
  return replace(source, '\t\tbaseUrl,\n\t\tapiKey: auth.apiKey,\n\t\theaders,', '\t\tproviderId: ctx.provider,\n\t\tbaseUrl,\n\t\tapiKey: auth.apiKey,\n\t\theaders,');
}

function patchVideoModelDefaults(source) {
  source = replace(source, '\t\tasync prepareCandidate(candidate, provider) {', `\t\tasync prepareCandidate(candidate, provider) {
\t\t\tconst mediaModel = params.cfg.models?.providers?.[candidate.provider]?.media?.models.find((model) => model.id === candidate.model && model.capabilities.includes("videoGenerate"));`);
  source = replace(source, '\t\t\t\ttimeoutMs: requestedTimeoutMs,', '\t\t\t\ttimeoutMs: requestedTimeoutMs ?? mediaModel?.timeoutMs,');
  source = replace(source, '\t\t\t\t\taspectRatio: params.aspectRatio,', '\t\t\t\t\taspectRatio: params.aspectRatio ?? mediaModel?.aspectRatio,');
  return replace(source, '\t\t\t\t\tresolution: params.resolution,', '\t\t\t\t\tresolution: params.resolution ?? mediaModel?.resolution,');
}

function patchVideoTaskRegistry(source) {
  source = replace(source, 'export { getTaskFlowById as $,', 'export { updateVideoGenerationTaskRecord, getTaskDeliveryState, getTaskFlowById as $,');
  return replace(source, '/** Publishes a record already committed by a cross-owner shared-state transaction. */', `function updateVideoGenerationTaskRecord(taskId, patch) {
\tconst current = getTaskById(taskId);
\tif (!current || current.runtime !== "cli" || current.taskKind !== "video_generation") return null;
\tconst next = { ...current, ...patch };
\tif (isTerminalTaskStatus(next.status)) patch = { ...patch, cleanupAfter: resolveTaskCleanupAfter({ ...next, endedAt: Math.max(next.endedAt ?? 0, next.lastEventAt ?? 0) }) };
\treturn updateTask(taskId, patch);
}
/** Publishes a record already committed by a cross-owner shared-state transaction. */`);
}

function patchVideoTaskTools(source, workspaceRootsImport, workspaceRootsExport) {
  const stamp = source.match(/^\/\/ matcha-native-searxng-v3 sha256=([a-f0-9]{64})\n/);
  const digest = (text) => createHash('sha256').update(text).digest('hex');
  if (stamp && digest(source.slice(stamp[0].length)) !== stamp[1]) throw new Error(`${PATCH}: native search source seal mismatch`);
  let body = stamp ? source.slice(stamp[0].length) : source;
  const sessionStoreImports = [...body.matchAll(/\t{4}const \{ loadGatewaySessionEntryReadOnly \} = await import\("(\.\/session-utils-store-[^"/]+\.mjs)"\);\n\t{4}const entry = loadGatewaySessionEntryReadOnly/g)];
  if (sessionStoreImports.length !== 1) throw new Error(`${PATCH}: expected one native session store import`);
  const sessionStoreImport = sessionStoreImports[0][1];
  const imports = [...body.matchAll(/^import \{ ([^\n]+) \} from "(\.\/task-registry-[^"/]+\.mjs)";$/gm)];
  if (imports.length !== 1) throw new Error(`${PATCH}: expected one native task registry import`);
  const [line, bindings, specifier] = imports[0];
  let taskBindings = bindings.includes('S as getTaskById') ? bindings : `S as getTaskById, ${bindings}`;
  if (!taskBindings.includes('updateVideoGenerationTaskRecord')) taskBindings += ', updateVideoGenerationTaskRecord';
  if (!taskBindings.includes('getTaskDeliveryState')) taskBindings += ', getTaskDeliveryState';
  body = replace(body, line, `import { ${taskBindings} } from "${specifier}";`);
  body = replace(body, '\treturn task.status === "queued" || task.status === "running";', '\treturn task.status === "queued" || task.status === "running" || task.taskKind === "video_generation" && task.deliveryStatus === "pending";');
  body = replace(body, '\tconst active = params.task.status === "queued" || params.task.status === "running" || params.task.terminalOutcome === "blocked";', '\tconst active = isTaskStillBlockingDuplicateGuard(params.task) || params.task.terminalOutcome === "blocked";');
  body = replace(body, 'function failMediaGenerationTaskRun(params) {\n\tif (!params.handle) return;', `function failMediaGenerationTaskRun(params) {
\tif (!params.handle) return;
\tif (params.error?.name === "VideoGenerationTimeoutError") {
\t\ttry {
\t\t\tconst endedAt = Date.now();
\t\t\tfailTaskRunByRunId({ runId: params.handle.runId, runtime: "cli", sessionKey: params.handle.requesterSessionKey, status: "timed_out", endedAt, lastEventAt: endedAt, error: formatErrorMessage(params.error), progressSummary: "Video wait timed out; cloud job may still be running" });
\t\t} finally { clearMediaGenerationTaskRunContext(params.handle); }
\t\treturn;
\t}`);
  body = replace(body, '\t\t\t\t\tresult: formatErrorMessage(error)\n', `\t\t\t\t\tresult: error?.name === "VideoGenerationTimeoutError"
\t\t\t\t\t\t? "Local video wait timed out. The provider may still be generating. Do not say the cloud job failed or submit another video. Explain that the original task can be checked without generating again."
\t\t\t\t\t\t: formatErrorMessage(error)
`);
  body = replace(body, 'const GENERATED_VIDEO_MEDIA_SUBDIR = "tool-video-generation";', 'const GENERATED_VIDEO_MEDIA_SUBDIR = "media/tool-video-generation";');
  body = replace(body, 'model: Type.Optional(Type.String({ description: "Provider/model override, e.g. qwen/wan2.6-t2v." })),\n\tfilename: Type.Optional(Type.String({ description: "Output filename hint; basename preserved in managed media dir." })),', 'model: Type.Optional(Type.String({ description: "Provider/model override, e.g. qwen/wan2.6-t2v." })),\n\tfilename: Type.Optional(Type.String({ description: "Output filename hint; basename preserved under the session workspace media/tool-video-generation directory." })),');
  const start = body.indexOf('async function executeVideoGenerationJob(params) {');
  const end = body.indexOf('\n//#endregion', start);
  if (start < 0 || end < 0) throw new Error(`${PATCH}: video tool region missing`);
  let tool = body.slice(start, end);
  tool = replace(tool, '\t\ttimeoutMs: params.timeoutMs\n\t}, createCapabilityProviderRuntimeDeps(params.providers));', `\t\ttimeoutMs: params.timeoutMs,
\t\tonJobSubmitted: (job) => recordVideoGenerationJob(params, job)
\t}, createCapabilityProviderRuntimeDeps(params.providers));`);
  tool = replace(tool, '\tif (params.taskHandle) videoGenerationTaskLifecycle.recordTaskProgress({\n\t\thandle: params.taskHandle,\n\t\tprogressSummary: "Saving generated video"', `\treturn await persistVideoGenerationResult(params, result);
}
async function persistVideoGenerationResult(params, result) {
\tif (params.taskHandle) videoGenerationTaskLifecycle.recordTaskProgress({
\t\thandle: params.taskHandle,
\t\tprogressSummary: "Saving generated video"`);
  tool = replace(tool, '\t\t\tconst action = resolveGenerateAction(args);', `\t\t\tif (normalizeOptionalLowercaseString(readToolStringParam(args, "action")) === "refresh") return await refreshVideoGenerationTask({ cfg, options, providers: preparedProviders, scheduleBackgroundWork, taskId: readToolStringParam(args, "taskId", { required: true }) });
\t\t\tconst action = resolveGenerateAction(args);`);
  tool = replace(tool, '\t\t\tif (action === "status") return createVideoGenerateStatusActionResult(options?.agentSessionKey, options?.requesterAgentId);', '\t\t\tif (action === "status") return createVideoGenerateStatusActionResult(options?.agentSessionKey, options?.requesterAgentId);\n\t\t\tconst { workspaceDir, sandbox } = await resolveGeneratedMediaWorkspace(options);');
  tool = replace(tool, '\t\t\t\trun: (taskHandle) => executeVideoGenerationJob({\n\t\t\t\t\teffectiveCfg,', '\t\t\t\trun: (taskHandle) => executeVideoGenerationJob({\n\t\t\t\t\teffectiveCfg,\n\t\t\t\t\tworkspaceDir,\n\t\t\t\t\tsandbox,');
  tool = replace(tool, '\t\tsubdir: GENERATED_VIDEO_MEDIA_SUBDIR,\n\t\tmode: "sequential",', '\t\tsubdir: GENERATED_VIDEO_MEDIA_SUBDIR,\n\t\trootDir: params.workspaceDir,\n\t\tsandbox: params.sandbox,\n\t\tmode: "sequential",');
  tool = replace(tool, 'await saveMediaBuffer(video.buffer, video.mimeType, GENERATED_VIDEO_MEDIA_SUBDIR, mediaMaxBytes, params.filename || video.fileName)', 'await saveMediaBuffer(video.buffer, video.mimeType, GENERATED_VIDEO_MEDIA_SUBDIR, mediaMaxBytes, params.filename || video.fileName, void 0, params.workspaceDir, params.sandbox)');
  body = body.slice(0, start) + tool + body.slice(end);
  body = replace(body, 'const VideoGenerateToolProperties = {\n', 'const VideoGenerateToolProperties = {\n\ttaskId: Type.Optional(Type.String({ description: "Original task id for action=refresh; never creates a new video." })),\n');
  body = replace(body, 'action: Type.Optional(Type.String({ description: "\\\"generate\\\" default, \\\"status\\\" active task, \\\"list\\\" providers/models." })),\n\tprompt: Type.Optional(Type.String({ description: "Video prompt." })),', 'action: Type.Optional(Type.String({ description: "\\\"generate\\\" default, \\\"status\\\" active task, \\\"list\\\" providers/models, \\\"refresh\\\" retrieves the original task without generating again." })),\n\tprompt: Type.Optional(Type.String({ description: "Video prompt." })),');
  body = replace(body, 'async function executeVideoGenerationJob(params) {', `const videoTaskRefreshes = new Map();
function recordVideoGenerationJob(params, job) {
\tconst handle = params.taskHandle;
\tif (!handle) return;
\tconst task = getTaskById(handle.taskId);
\tif (!task || task.runId !== handle.runId || task.taskKind !== "video_generation" || task.requesterSessionKey !== handle.requesterSessionKey) throw new Error("Video task ownership changed before submission could be recorded");
\tconst videoGeneration = { provider: job.provider, model: job.model, videoId: job.videoId, workspaceDir: params.workspaceDir, wasSandboxed: Boolean(params.sandbox) };
\tif (!updateVideoGenerationTaskRecord(task.taskId, { detail: { ...task.detail, videoGeneration }, lastEventAt: Date.now() })) throw new Error("Could not persist the submitted video task");
}
async function refreshVideoGenerationTask({ cfg, options, providers, scheduleBackgroundWork, taskId }) {
\tconst reject = (errorCode, message) => ({ content: [{ type: "text", text: message }], details: { taskId, status: "error", errorCode } });
\tconst task = getTaskById(taskId);
\tconst sessionKey = options?.agentSessionKey?.trim();
\tif (!sessionKey || !task || task.runtime !== "cli" || task.scopeKind !== "session" || task.taskKind !== "video_generation"
\t\t|| task.ownerKey !== sessionKey || task.requesterSessionKey !== sessionKey || !task.runId?.startsWith("tool:video_generate:")
\t\t|| resolveMediaGenerationTaskRequesterAgentId(task) !== (options?.requesterAgentId ?? resolveAgentIdFromSessionKey(sessionKey))) return reject("task_unavailable", "Video task does not belong to this session");
\tconst response = (status) => ({ content: [{ type: "text", text: "Original video task: " + status }], details: { taskId, status } });
\tif (task.status === "succeeded") return response("completed");
\tif (task.status === "queued" || task.status === "running" || task.status === "cancelled") return response(task.status);
\tif (task.status !== "failed" && task.status !== "timed_out") return reject("task_unavailable", "Video task is not available for recovery");
\tconst job = task.detail?.videoGeneration;
\tif (!job || ![job.provider, job.model, job.videoId, job.workspaceDir].every((value) => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 4096 && !/[\\u0000-\\u001f\\u007f]/.test(value)) || !path.isAbsolute(job.workspaceDir) || typeof job.wasSandboxed !== "boolean") return reject("missing_job_reference", "This video task has no saved cloud job and workspace reference and cannot be retrieved automatically");
\tif (job.wasSandboxed || options?.sandbox || options?.sandboxed) return reject("task_unavailable", "The original sandbox filesystem bridge cannot be verified; this video task cannot be retrieved automatically");
\tconst { loadGatewaySessionEntryReadOnly } = await import("${sessionStoreImport}");
\tconst { ${workspaceRootsExport}: resolveSessionWorkspaceRoots } = await import("${workspaceRootsImport}");
\tconst agentId = resolveMediaGenerationTaskRequesterAgentId(task);
\tconst { entry } = loadGatewaySessionEntryReadOnly(sessionKey, { agentId });
\tif (!entry) return reject("task_unavailable", "The original session is no longer available");
\tconst root = entry.sessionRoot ?? resolveSessionWorkspaceRoots(cfg, agentId, entry).root;
\tif (!root) return reject("task_unavailable", "The session filesystem root is unavailable");
\tlet workspace;
\ttry {
\t\tworkspace = await resolveGeneratedMediaWorkspace({
\t\t\t...options,
\t\t\tworkspaceDir: job.workspaceDir,
\t\t\tfsPolicy: { workspaceOnly: true, root },
\t\t\tsessionPermissionPolicy: { root, mode: entry.permissionMode }
\t\t});
\t} catch (error) { return reject("task_unavailable", formatErrorMessage(error)); }
\tconst { workspaceDir, sandbox } = workspace;
\tconst pending = videoTaskRefreshes.get(taskId);
\tif (pending) return await pending;
\tconst provider = (providers ?? listRuntimeVideoGenerationProviders({ config: cfg })).find((entry) => entry.id === job.provider);
\tif (typeof provider?.readVideo !== "function") return reject("provider_unsupported", "This video provider does not support retrieving an original task");
\tlet delivering = false;
\tconst operation = (async () => {
\t\tlet result;
\t\ttry {
\t\t\tresult = await provider.readVideo({ cfg, agentDir: options?.agentDir, authStore: options?.authProfileStore, model: job.model, videoId: job.videoId, timeoutMs: 20000 });
\t\t} catch (error) {
\t\t\tif (error?.name !== "VideoGenerationFailedError") throw error;
\t\t\tif (!updateVideoGenerationTaskRecord(taskId, { status: "failed", error: formatErrorMessage(error), endedAt: Date.now(), lastEventAt: Date.now() })) throw new Error("Could not persist video task status");
\t\t\treturn response("failed");
\t\t}
\t\tif (result.status !== "completed") return response(result.status);
\t\tconst current = getTaskById(taskId);
\t\tif (!current || current.runId !== task.runId || current.status === "cancelled") return reject("task_unavailable", "Video task is no longer available for recovery");
\t\tif (!updateVideoGenerationTaskRecord(taskId, { deliveryStatus: "pending", progressSummary: MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS, lastEventAt: Date.now() })) throw new Error("Could not record video recovery");
\t\tconst handle = { taskId, runId: task.runId, requesterSessionKey: sessionKey, requesterAgentId: resolveMediaGenerationTaskRequesterAgentId(task), requesterOrigin: getTaskDeliveryState(taskId)?.requesterOrigin, taskLabel: task.task };
\t\tconst lifecycle = {
\t\t\t...videoGenerationTaskLifecycle,
\t\t\tcompleteTaskRun(completion) {
\t\t\t\ttry {
\t\t\t\t\tconst endedAt = Date.now();
\t\t\t\t\tif (!updateVideoGenerationTaskRecord(taskId, { status: "succeeded", error: void 0, endedAt, lastEventAt: endedAt, deliveryStatus: completion.terminalResult?.terminalOutcome === "blocked" ? "failed" : "delivered", progressSummary: "Generated " + completion.count + " video", terminalSummary: completion.terminalResult?.terminalSummary ?? "Retrieved the original generated video", terminalOutcome: completion.terminalResult?.terminalOutcome ?? "succeeded" })) throw new Error("Could not persist recovered video completion");
\t\t\t\t} finally { clearMediaGenerationTaskRunContext(handle); }
\t\t\t},
\t\t\tfailTaskRun({ error }) {
\t\t\t\ttry {
\t\t\t\t\tconst endedAt = Date.now();
\t\t\t\t\tif (!updateVideoGenerationTaskRecord(taskId, { status: "failed", error: formatErrorMessage(error), endedAt, lastEventAt: endedAt, deliveryStatus: "failed", progressSummary: "Video recovery failed" })) throw new Error("Could not persist video recovery failure");
\t\t\t\t} finally { clearMediaGenerationTaskRunContext(handle); }
\t\t\t}
\t\t};
\t\tscheduleMediaGenerationTaskCompletion({
\t\t\tlifecycle, handle, config: cfg, toolName: "Video generation", progressSummary: MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS,
\t\t\tscheduleBackgroundWork(work) {
\t\t\t\tdelivering = true;
\t\t\t\tscheduleBackgroundWork(async () => { try { await work(); } finally { videoTaskRefreshes.delete(taskId); } });
\t\t\t},
\t\t\tonWakeFailure: (message, meta) => log.warn(message, meta),
\t\t\trun: () => persistVideoGenerationResult({ effectiveCfg: cfg, workspaceDir, sandbox, taskHandle: handle, loadedReferenceImages: [], loadedReferenceVideos: [], loadedReferenceAudios: [] }, { ...result, provider: job.provider, attempts: [] })
\t\t});
\t\treturn response("completed");
\t})().finally(() => { if (!delivering) videoTaskRefreshes.delete(taskId); });
\tvideoTaskRefreshes.set(taskId, operation);
\treturn await operation;
}
async function executeVideoGenerationJob(params) {`);
  return stamp ? `// matcha-native-searxng-v3 sha256=${digest(body)}\n${body}` : body;
}

function patchVideoJobRuntime(source) {
  source = replace(source, 'async function generateVideo(params, deps = {}) {', 'async function generateVideo(params, deps = {}) {\n\tlet submittedJob;\n\tlet submittedError;');
  source = replace(source, '\t\t\tlogger.debug(`video-generation candidate failed: ${attempt.provider}/${attempt.model}`);', '\t\t\tlogger.debug(`video-generation candidate failed: ${attempt.provider}/${attempt.model}`);\n\t\t\tif (submittedJob || submittedError) throw submittedError ?? new Error(attempt.error);');
  source = replace(source, '\t\t\t\t\tproviderOptions: params.providerOptions,\n\t\t\t\t\t...timeoutMs', `\t\t\t\t\tproviderOptions: params.providerOptions,
\t\t\t\t\tonJobSubmitted: async (job) => { submittedJob = job; await params.onJobSubmitted?.(job); },
\t\t\t\t\t...timeoutMs`);
  return replace(source, '\t\t\t\tconst result = await provider.generateVideo(generationRequest);', `\t\t\t\tlet result;
\t\t\t\ttry { result = await provider.generateVideo(generationRequest); }
\t\t\t\tcatch (error) { if (submittedJob || error?.name === "VideoGenerationTimeoutError") submittedError = error; throw error; }`);
}

function patchVideoTaskDisplay(source) {
  return replace(source, '\tconst projected = {};\n\tconst browserTab = asOptionalRecord(record.browserTab);', `\tconst projected = {};
\tconst taskId = record.taskId ?? record.task?.taskId;
\tconst runId = record.runId ?? record.task?.runId;
\tif (record.async === true && record.status === "started"
\t\t&& isBrowserRouteIdentifier(taskId, 4096) && !/[\\u0000-\\u001f\\u007f]/.test(taskId)
\t\t&& isBrowserRouteIdentifier(runId, 4096) && /^tool:(?:image|video)_generate:/.test(runId)
\t\t&& !/[\\u0000-\\u001f\\u007f]/.test(runId)
\t\t&& (record.task?.taskId === void 0 || record.task.taskId === taskId)
\t\t&& (record.task?.runId === void 0 || record.task.runId === runId)) {
\t\tprojected.async = true;
\t\tprojected.status = "started";
\t\tprojected.taskId = taskId;
\t\tprojected.runId = runId;
\t}
\tconst browserTab = asOptionalRecord(record.browserTab);`);
}

export function patchOpenClawVideo(openclawDir) {
  const pkg = JSON.parse(read(path.join(openclawDir, 'package.json')));
  if (pkg.name !== 'openclaw' || pkg.version !== VERSION) throw new Error(`${PATCH}: requires openclaw@${VERSION}`);
  const dist = path.join(openclawDir, 'dist');
  const workspaceRootsFile = locate(dist, 'session-workspace-roots-', ['function resolveSessionWorkspaceRoots(']);
  const workspaceRootsImport = `./${path.basename(workspaceRootsFile)}`;
  const workspaceRootsExports = [...read(workspaceRootsFile).matchAll(/export \{ resolveSessionWorkspaceRoots as ([A-Za-z_$][\w$]*) \};/g)];
  if (workspaceRootsExports.length !== 1) throw new Error(`${PATCH}: expected one native workspace roots export`);
  const workspaceRootsExport = workspaceRootsExports[0][1];
  const edits = [
    [path.join(dist, 'extensions/openai/index.js'), patchOpenAIVideoRegistration],
    [locate(dist, 'video-generation-provider-', ['function buildOpenAIVideoGenerationProvider(']), patchOpenAIVideoFactory],
    [path.join(dist, 'extensions/google/index.js'), patchGoogleVideoRegistration],
    [path.join(dist, 'extensions/google/video-generation-provider.js'), patchGoogleVideoFactory],
    [locate(dist, 'generation-provider-metadata-', ['function createGoogleVideoGenerationProviderMetadata(']), patchGoogleVideoMetadata],
    [path.join(dist, 'extensions/openrouter/index.js'), patchOpenRouterVideoRegistration],
    [locate(dist, 'video-generation-provider-', ['function buildOpenRouterVideoGenerationProvider(']), patchOpenRouterVideoFactory],
    [locate(dist, 'video-model-catalog-', ['function resolveOpenRouterVideoCatalogRequest(', 'async function resolveOpenRouterVideoModelCapabilities(']), patchOpenRouterVideoCapabilities],
    [locate(dist, 'runtime-', ['async function generateVideo(']), (source) => patchVideoJobRuntime(patchVideoModelDefaults(source))],
    [locate(dist, 'task-registry-', ['function getTaskById(taskId)', 'function updateTask(taskId, patch']), patchVideoTaskRegistry],
    [locate(dist, 'openclaw-tools-', ['function createVideoGenerateTool(options)']), (source) => patchVideoTaskTools(source, workspaceRootsImport, workspaceRootsExport)],
    [locate(dist, 'chat-display-projection.canvas-', ['function projectToolResultDetails(details, maxChars)']), patchVideoTaskDisplay],
  ].map(([file, transform]) => {
    const before = read(file);
    return { file, before, after: transform(before) };
  });
  const changed = edits.filter(({ before, after }) => before !== after);
  for (const { file, after } of changed) fs.writeFileSync(file, after);
  return {
    status: changed.length ? 'applied' : 'clean',
    detail: `OpenClaw ${VERSION} native OpenAI/Google/OpenRouter account video providers (${changed.length} files)`,
  };
}
