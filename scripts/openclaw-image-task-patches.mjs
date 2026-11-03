import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const VERSION = '2026.9.3';
const PATCH = 'native-image-task-cancellation';
const read = (file) => fs.readFileSync(file, 'utf8');
const digest = (source) => createHash('sha256').update(source).digest('hex');

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

export function patchImageTaskTools(source) {
  // Search already seals this shared bundle; validate and preserve that seal.
  const stamp = source.match(/^\/\/ matcha-native-searxng-v3 sha256=([a-f0-9]{64})\n/);
  if (stamp && digest(source.slice(stamp[0].length)) !== stamp[1]) throw new Error(`${PATCH}: native search source seal mismatch`);
  let body = stamp ? source.slice(stamp[0].length) : source;
  const imports = [...body.matchAll(/^import \{ ([^\n]+) \} from "(\.\/task-registry-[^"/]+\.mjs)";$/gm)];
  if (imports.length !== 1) throw new Error(`${PATCH}: expected one native task registry import`);
  const [line, bindings, specifier] = imports[0];
  body = replace(body, line, `import { S as getTaskById, _ as bindTaskRunOwner, ${bindings.replace('S as getTaskById, _ as bindTaskRunOwner, ', '')} } from "${specifier}";`);
  body = replace(body, '\t\ttouchMediaGenerationTaskRunContext(handle);\n\t\treturn handle;', `\t\tif (params.toolName === "image_generate") {
\t\t\thandle.abortController = new AbortController();
\t\t\thandle.signal = params.signal ? AbortSignal.any([params.signal, handle.abortController.signal]) : handle.abortController.signal;
\t\t\thandle.settled = new Promise((resolve) => { handle.resolveSettled = resolve; });
\t\t\thandle.releaseTaskOwner = bindTaskRunOwner(task, async (reason) => {
\t\t\t\tif (handle.deliveringCompletion) return { ok: false, error: "Image generation has finished; completion delivery is in progress." };
\t\t\t\thandle.abortController.abort(new Error(reason));
\t\t\t\tawait handle.settled;
\t\t\t\tconst current = getTaskById(task.taskId);
\t\t\t\treturn current?.status === "cancelled" ? { ok: true, value: current } : { ok: false, error: "Image generation cancellation was not confirmed. Inspect its final result." };
\t\t\t});
\t\t}
\t\ttouchMediaGenerationTaskRunContext(handle);
\t\treturn handle;`);
  body = replace(body, 'function clearMediaGenerationTaskRunContext(handle) {', `function releaseMediaGenerationTaskOwner(handle) {
\thandle?.releaseTaskOwner?.();
\thandle?.resolveSettled?.();
}
function clearMediaGenerationTaskRunContext(handle) {`);
  body = replace(body, 'function failMediaGenerationTaskRun(params) {', `function isMediaGenerationTaskCancellation(handle, error) {
\treturn handle?.signal?.aborted === true && error?.name !== "MediaGenerationCleanupError";
}
function failMediaGenerationTaskRun(params) {`);
  const previousFailure = '\t\tconst cancelled = params.handle.signal?.aborted === true && params.error?.name !== "MediaGenerationCleanupError";\n\t\tconst errorText = formatErrorMessage(params.error);\n\t\tconst cancellationReason = cancelled ? formatErrorMessage(params.handle.signal.reason) : void 0;\n\t\tfailTaskRunByRunId({';
  body = replace(body, body.includes(previousFailure) ? previousFailure : '\t\tconst errorText = formatErrorMessage(params.error);\n\t\tfailTaskRunByRunId({', `\t\tconst cancelled = isMediaGenerationTaskCancellation(params.handle, params.error);
\t\tconst errorText = formatErrorMessage(params.error);
\t\tconst cancellationReason = cancelled ? formatErrorMessage(params.handle.signal.reason) : void 0;
\t\tfailTaskRunByRunId({`);
  body = replace(body, '\t\t\terror: errorText,\n\t\t\tprogressSummary: params.progressSummary,\n\t\t\tterminalSummary: errorText', `\t\t\tstatus: cancelled ? "cancelled" : "failed",
\t\t\terror: cancellationReason ?? errorText,
\t\t\tprogressSummary: cancelled ? "Image generation cancelled" : params.progressSummary,
\t\t\tterminalSummary: cancellationReason && cancellationReason !== errorText ? cancellationReason + ": " + errorText : errorText`);
  const previousCompletion = '\t\t} catch (error) {\n\t\t\tif (params.handle?.signal?.aborted) {\n\t\t\t\tparams.lifecycle.failTaskRun({ handle: params.handle, error });\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tif (params.handle?.abortController) params.handle.deliveringCompletion = true;\n\t\t\ttry {\n\t\t\t\tif ((await wakeMediaGenerationTaskCompletionWithRetry';
  body = replace(body, body.includes(previousCompletion) ? previousCompletion : '\t\t} catch (error) {\n\t\t\ttry {\n\t\t\t\tif ((await wakeMediaGenerationTaskCompletionWithRetry', `\t\t} catch (error) {
\t\t\tif (isMediaGenerationTaskCancellation(params.handle, error)) {
\t\t\t\tparams.lifecycle.failTaskRun({ handle: params.handle, error });
\t\t\t\treturn;
\t\t\t}
\t\t\tif (params.handle?.abortController) params.handle.deliveringCompletion = true;
\t\t\ttry {
\t\t\t\tif ((await wakeMediaGenerationTaskCompletionWithRetry`);
  body = replace(body, '\t\tconst recordCompletionDeliveryProgress = () => {', '\t\tif (params.handle?.abortController) params.handle.deliveringCompletion = true;\n\t\tconst recordCompletionDeliveryProgress = () => {');
  body = replace(body, '\tparams.scheduleBackgroundWork(() => runWithoutOwnedSessionTranscriptWrites(runBackgroundWork));', `\tparams.scheduleBackgroundWork(() => runWithoutOwnedSessionTranscriptWrites(async () => {
\t\ttry {
\t\t\tawait runBackgroundWork();
\t\t} finally {
\t\t\treleaseMediaGenerationTaskOwner(params.handle);
\t\t}
\t}));`);
  body = replace(body, '\t\tprompt: params.prompt,\n\t\tproviderId: params.providerId\n\t});', `\t\tprompt: params.prompt,
\t\tproviderId: params.providerId,
\t\tsignal: params.signal
\t});`);
  body = replace(body, '\tif (handle && shouldDetachMediaGenerationTask(params.sessionKey, params.requesterAgentId)) {', `\tif (handle && shouldDetachMediaGenerationTask(params.sessionKey, params.requesterAgentId)) {
\t\t// Yield aborts the foreground run; detached work belongs to the task owner.
\t\tif (handle.abortController) {
\t\t\tif (params.signal?.aborted) handle.abortController.abort(params.signal.reason);
\t\t\thandle.signal = handle.abortController.signal;
\t\t}`);
  body = replace(body, '\t\tthrow error;\n\t}\n}\n/** Shared lifecycle instance configured for image generation. */', `\t\tthrow error;
\t} finally {
\t\treleaseMediaGenerationTaskOwner(handle);
\t}
}
/** Shared lifecycle instance configured for image generation. */`);
  body = replace(body, 'async function executeImageGenerationJob(params) {', 'async function executeImageGenerationJob(params) {\n\tparams.signal?.throwIfAborted();');
  body = replace(body, '\t\tproviderOptions: params.providerOptions,\n\t\tssrfPolicy: params.ssrfPolicy\n\t}, createCapabilityProviderRuntimeDeps(params.providers));\n\tif (params.taskHandle) imageGenerationTaskLifecycle', `\t\tproviderOptions: params.providerOptions,
\t\tsignal: params.signal,
\t\tssrfPolicy: params.ssrfPolicy
\t}, createCapabilityProviderRuntimeDeps(params.providers));
\tparams.signal?.throwIfAborted();
\tif (params.taskHandle) imageGenerationTaskLifecycle`);
  body = replace(body, '/** Gives generated-media batches all-or-nothing result semantics with best-effort rollback. */', `async function rollbackGeneratedImageCancellation(savedMedia, subdir, reason) {
\tconst results = await Promise.allSettled(savedMedia.map((saved) => deleteMediaBuffer(saved.id, subdir)));
\tconst failures = results.flatMap((result) => result.status === "rejected" ? [formatErrorMessage(result.reason)] : []);
\tif (failures.length) {
\t\tconst error = new Error(formatErrorMessage(reason) + "; generated image cleanup failed: " + failures.join("; "));
\t\terror.name = "MediaGenerationCleanupError";
\t\tthrow error;
\t}
}
/** Gives generated-media batches all-or-nothing result semantics with best-effort rollback. */`);
  body = replace(body, '\t\tsubdir: GENERATED_IMAGE_MEDIA_SUBDIR,\n\t\tmode: "concurrent",', '\t\tsubdir: GENERATED_IMAGE_MEDIA_SUBDIR,\n\t\tsignal: params.signal,\n\t\tmode: "concurrent",');
  body = replace(body, '\tconst revisedPrompts = result.images.map((image) => image.revisedPrompt?.trim()).filter((entry) => Boolean(entry));', `\tif (params.signal?.aborted) {
\t\tawait rollbackGeneratedImageCancellation(savedImages, GENERATED_IMAGE_MEDIA_SUBDIR, params.signal.reason);
\t\tparams.signal.throwIfAborted();
\t}
\tif (params.taskHandle?.abortController) params.taskHandle.deliveringCompletion = true;
\tconst revisedPrompts = result.images.map((image) => image.revisedPrompt?.trim()).filter((entry) => Boolean(entry));`);
  body = replace(body, '\t\ttry {\n\t\t\tconst result = await save();\n\t\t\tsavedMedia[index] = result.savedMedia;\n\t\t\treturn result.value;', `\t\ttry {
\t\t\tparams.signal?.throwIfAborted();
\t\t\tconst result = await save();
\t\t\tsavedMedia[index] = result.savedMedia;
\t\t\tparams.signal?.throwIfAborted();
\t\t\treturn result.value;`);
  body = replace(body, '\tif (firstFailure) {\n\t\tawait Promise.allSettled(savedMedia.flatMap((saved) => saved ? [Promise.resolve().then(() => deleteMediaBuffer(saved.id, params.subdir))] : []));', `\tif (params.signal?.aborted) firstFailure ??= { error: params.signal.reason };
\tif (firstFailure) {
\t\tif (params.signal?.aborted) await rollbackGeneratedImageCancellation(savedMedia.filter(Boolean), params.subdir, firstFailure.error);
\t\telse await Promise.allSettled(savedMedia.flatMap((saved) => saved ? [Promise.resolve().then(() => deleteMediaBuffer(saved.id, params.subdir))] : []));`);
  body = replace(body, '\t\t\t\tlifecycle: imageGenerationTaskLifecycle,\n\t\t\t\tgenerationLabel: "image",', `\t\t\t\tlifecycle: imageGenerationTaskLifecycle,
\t\t\t\tgenerationLabel: "image",
\t\t\t\tsignal,`);
  body = replace(body, '\t\t\t\trun: (taskHandle) => executeImageGenerationJob({\n\t\t\t\t\teffectiveCfg,', '\t\t\t\trun: (taskHandle) => executeImageGenerationJob({\n\t\t\t\t\tsignal: taskHandle?.signal ?? signal,\n\t\t\t\t\teffectiveCfg,');
  return stamp ? `// matcha-native-searxng-v3 sha256=${digest(body)}\n${body}` : body;
}

export function patchImageGenerationRuntime(source) {
  source = replace(source, 'async function generateImage(params, deps = {}) {', 'async function generateImage(params, deps = {}) {\n\tparams.signal?.throwIfAborted();');
  source = replace(source, '\t\tcapability: "image",\n\t\tgetProvider:', '\t\tcapability: "image",\n\t\tsignal: params.signal,\n\t\tgetProvider:');
  source = replace(source, '\t\t\t\t\tproviderOptions: params.providerOptions,\n\t\t\t\t\tssrfPolicy: params.ssrfPolicy', '\t\t\t\t\tproviderOptions: params.providerOptions,\n\t\t\t\t\tsignal: params.signal,\n\t\t\t\t\tssrfPolicy: params.ssrfPolicy');
  return replace(source, '\t\t\t\tif (!Array.isArray(result.images)', '\t\t\t\tparams.signal?.throwIfAborted();\n\t\t\t\tif (!Array.isArray(result.images)');
}

export function patchMediaGenerationCandidateCancellation(source) {
  source = replace(source, '\tfor (const candidate of params.candidates) {\n\t\tconst provider = params.getProvider(candidate.provider);', '\tfor (const candidate of params.candidates) {\n\t\tparams.signal?.throwIfAborted();\n\t\tconst provider = params.getProvider(candidate.provider);');
  return replace(source, '\t\t} catch (error) {\n\t\t\tlastError = error;', '\t\t} catch (error) {\n\t\t\tif (params.signal?.aborted) throw error;\n\t\t\tlastError = error;');
}

export function patchOpenRouterImageCancellation(source) {
  source = patchImageProviderSignals(source, 2);
  source = replace(source, '\t\t\t\timages: (await Promise.all(Array.from({ length: count }, async () => {', '\t\t\t\timages: (await Promise.allSettled(Array.from({ length: count }, async () => {');
  return replace(source, '\t\t\t\t}))).flat(),', '\t\t\t\t}))).flatMap((entry) => {\n\t\t\t\t\tif (entry.status === "rejected") throw entry.reason;\n\t\t\t\t\treturn entry.value;\n\t\t\t\t}),');
}

export function patchImageProviderSignals(source, expected) {
  const anchors = [...source.matchAll(/^(\t+)ssrfPolicy: req\.ssrfPolicy,$/gm)];
  const patched = [...source.matchAll(/^(\t+)signal: req\.signal,\n\1ssrfPolicy: req\.ssrfPolicy,$/gm)];
  if (anchors.length !== expected || (patched.length !== 0 && patched.length !== expected)) {
    throw new Error(`${PATCH}: provider signal anchor mismatch: expected ${expected}, found ${anchors.length}/${patched.length}`);
  }
  if (patched.length === expected) return source;
  return source.replace(/^(\t+)ssrfPolicy: req\.ssrfPolicy,$/gm, '$1signal: req.signal,\n$&');
}

export function patchOpenClawImageTasks(openclawDir) {
  const pkg = JSON.parse(read(path.join(openclawDir, 'package.json')));
  if (pkg.name !== 'openclaw' || pkg.version !== VERSION) throw new Error(`${PATCH}: requires openclaw@${VERSION}`);
  const dist = path.join(openclawDir, 'dist');
  const edits = [
    [locate(dist, 'openclaw-tools-', ['function createImageGenerateTool(options)', 'function createMediaGenerationTaskRun(params)']), patchImageTaskTools],
    [locate(dist, 'runtime-', ['async function generateImage(params, deps = {})']), patchImageGenerationRuntime],
    [locate(dist, 'runtime-shared-', ['async function runMediaGenerationCandidates(params)']), patchMediaGenerationCandidateCancellation],
    [locate(dist, 'image-generation-', ['function createOpenAiCompatibleImageGenerationProvider(options)']), (source) => patchImageProviderSignals(source, 1)],
    [locate(dist, 'image-generation-provider-', ['function buildOpenAIImageGenerationProvider(']), (source) => patchImageProviderSignals(source, 3)],
    [path.join(dist, 'extensions/google/image-generation-provider.js'), (source) => patchImageProviderSignals(source, 1)],
    [locate(dist, 'image-generation-provider-', ['function buildOpenRouterImageGenerationProvider(']), patchOpenRouterImageCancellation],
  ].map(([file, transform]) => {
    const before = read(file);
    return { file, before, after: transform(before) };
  });
  const changed = edits.filter(({ before, after }) => before !== after);
  for (const { file, after } of changed) fs.writeFileSync(file, after);
  return {
    status: changed.length ? 'applied' : 'clean',
    detail: `OpenClaw ${VERSION} native image task cancellation, provider abort and settlement (${changed.length} files)`,
  };
}
