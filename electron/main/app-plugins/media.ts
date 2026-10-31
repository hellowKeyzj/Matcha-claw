import { createHash } from 'node:crypto';
import type { AppMediaModelList, AppMediaModelListRequest, AppModelRequest, AppModelResult, AppTextModelRequest, AppTextModelResult, AppVideoTask, AppVideoTaskRequest, AppVideoTaskResult } from '../../../src/types/desktop/app-plugin-sdk';
import type { RuntimeHostDeliveryIssuer } from '../runtime-host-delivery/issuer';
import { hasExactKeys, isRecord, sendLoopbackJsonDelivery } from '../runtime-host-delivery/transport/client';
import { fetchLoopbackHttp } from '../../utils/loopback-http';

export const MAX_PLUGIN_TEXT_REQUEST_BYTES = 48 * 1024 * 1024;

export function validatePluginTextRequest(value: unknown): string | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !['prompt', 'selectionId', 'images'].includes(key))) return 'Invalid text generation request.';
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 64_000
    || [...value.prompt].length > 32_000 || Buffer.byteLength(value.prompt, 'utf8') > 128_000) return 'Text generation requires a nonempty prompt of at most 32000 characters.';
  if (value.selectionId !== undefined && (typeof value.selectionId !== 'string' || !/^model-selection:v1:[0-9a-f]{64}$/.test(value.selectionId))) return 'Select a configured model using its canonical selection ID.';
  if (value.images !== undefined && (!Array.isArray(value.images) || value.images.length > 16)) return 'Text generation accepts at most 16 input images.';
  let totalBytes = 0;
  for (const image of (value.images ?? []) as unknown[]) {
    if (!isRecord(image) || !hasExactKeys(image, ['data', 'mimeType']) || typeof image.data !== 'string' || !image.data.length
      || image.data.length > Math.ceil(32 * 1024 * 1024 / 3) * 4 || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return 'Input images require valid base64 PNG, JPEG or WebP bytes.';
    const bytes = Buffer.from(image.data, 'base64');
    const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
    if (!mimeType || image.mimeType !== mimeType || bytes.toString('base64') !== image.data) return 'Input image bytes do not match their declared PNG, JPEG or WebP format.';
    totalBytes += bytes.length;
    if (totalBytes > 32 * 1024 * 1024) return 'Input images exceed the 32 MiB combined limit.';
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PLUGIN_TEXT_REQUEST_BYTES) return 'Text generation request exceeds the 48 MiB limit.';
  return null;
}

export async function generatePluginText(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  request: AppTextModelRequest,
  signal: AbortSignal,
): Promise<AppTextModelResult> {
  signal.throwIfAborted();
  const invalid = validatePluginTextRequest(request);
  if (invalid) throw new Error(invalid);
  const path = '/api/provider/text/generate';
  const serializedBody = JSON.stringify({ input: request });
  const delivery = await sendLoopbackJsonDelivery({
    issuer, port, path, method: 'POST', fetcher: fetchLoopbackHttp, serializedBody, signal, timeoutMs: 5 * 60 * 1000,
    decision: { endpoint: path, scope: 'providers:text', capability: 'providerText.generate', subject: 'provider-text',
      revision: createHash('sha256').update(serializedBody).digest('hex') },
  });
  signal.throwIfAborted();
  if (delivery.outcome !== 'response') throw new Error('Text generation outcome could not be observed; the provider request may already have occurred.');
  const { status, body: result } = delivery.response;
  if (status !== 200 && isRecord(result) && result.success === false && typeof result.code === 'string'
    && typeof result.error === 'string' && result.error.length > 0 && result.error.length <= 2000) throw new Error(result.error);
  if (status !== 200 || !isRecord(result) || !hasExactKeys(result, ['text']) || typeof result.text !== 'string'
    || !result.text.trim() || Buffer.byteLength(result.text, 'utf8') > 1024 * 1024) throw new Error('Text generation failed. Check the configured text or image-understanding model and provider account.');
  return { text: result.text };
}

export async function generatePluginMedia(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  request: AppModelRequest,
  signal: AbortSignal,
): Promise<AppModelResult> {
  return mediaOutput(await requestPluginMedia(issuer, port, 'generate', request, signal));
}

export async function listPluginMediaModels(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  request: AppMediaModelListRequest,
  signal: AbortSignal,
): Promise<AppMediaModelList> {
  if (!isRecord(request) || !hasExactKeys(request, ['kind']) || !['image', 'video'].includes(request.kind)) throw new Error('Media model listing requires an image or video kind.');
  const result = await requestPluginMedia(issuer, port, 'list', request, signal);
  if (!isRecord(result) || !hasExactKeys(result, result.defaultSelectionId === undefined ? ['models'] : ['models', 'defaultSelectionId'])
    || !Array.isArray(result.models) || !result.models.every((model) => {
      if (!isRecord(model) || !hasExactKeys(model, ['selectionId', 'name', 'capabilities']) || !isSelectionId(model.selectionId)
        || typeof model.name !== 'string' || !model.name.length || !isRecord(model.capabilities)) return false;
      const capabilities = model.capabilities;
      return Object.keys(capabilities).every((key) => ['maxImages', 'maxCount', 'mask', 'pixelSize', 'pixelSizeLimits', 'sizes', 'durationsSeconds', 'storyboard'].includes(key))
        && Number.isSafeInteger(capabilities.maxImages) && (capabilities.maxImages as number) >= 0 && (capabilities.maxImages as number) <= 16
        && Number.isSafeInteger(capabilities.maxCount) && (capabilities.maxCount as number) >= 1 && (capabilities.maxCount as number) <= 10
        && typeof capabilities.mask === 'boolean' && typeof capabilities.pixelSize === 'boolean' && capabilities.storyboard === false
        && (capabilities.pixelSize ? isPixelSizeLimits(capabilities.pixelSizeLimits) : capabilities.pixelSizeLimits === undefined)
        && (capabilities.sizes === undefined || (Array.isArray(capabilities.sizes) && capabilities.sizes.every((size) => typeof size === 'string' && size.length > 0 && size.length <= 128)))
        && (capabilities.durationsSeconds === undefined || (Array.isArray(capabilities.durationsSeconds) && capabilities.durationsSeconds.every((duration) => Number.isSafeInteger(duration) && duration > 0)));
    }) || (result.defaultSelectionId !== undefined && (!isSelectionId(result.defaultSelectionId)
      || !result.models.some((model) => model.selectionId === result.defaultSelectionId)))) throw new Error('The provider returned an invalid media model list.');
  return result as unknown as AppMediaModelList;
}

export async function submitPluginVideo(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  request: AppModelRequest & { readonly kind: 'video' },
  signal: AbortSignal,
): Promise<AppVideoTaskResult> {
  if (!isRecord(request) || request.kind !== 'video') throw new Error('Video submission requires a video request.');
  return videoTaskOutput(await requestPluginMedia(issuer, port, 'submitVideo', request, signal));
}

export async function queryPluginVideo(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  request: AppVideoTaskRequest,
  signal: AbortSignal,
): Promise<AppVideoTaskResult> {
  validateVideoTaskRequest(request);
  return videoTaskOutput(await requestPluginMedia(issuer, port, 'queryVideo', request, signal));
}

export async function collectPluginVideo(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  request: AppVideoTaskRequest,
  signal: AbortSignal,
): Promise<AppModelResult> {
  validateVideoTaskRequest(request);
  return mediaOutput(await requestPluginMedia(issuer, port, 'collectVideo', request, signal));
}

const MEDIA_PATHS = {
  generate: '/api/provider/media/generate',
  list: '/api/provider/media/models',
  submitVideo: '/api/provider/media/video/submit',
  queryVideo: '/api/provider/media/video/query',
  collectVideo: '/api/provider/media/video/collect',
} as const;

async function requestPluginMedia(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  operation: keyof typeof MEDIA_PATHS,
  request: AppModelRequest | AppMediaModelListRequest | AppVideoTaskRequest,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const path = MEDIA_PATHS[operation];
  const operationId = `providerMedia.${operation}`;
  const serializedBody = JSON.stringify({ id: 'provider.media', operationId, scope: { kind: 'provider-media' },
    target: { kind: 'provider-media' }, input: request });
  const maxBytes = operation === 'generate' || operation === 'submitVideo' ? 48 * 1024 * 1024 : 64 * 1024;
  if (Buffer.byteLength(serializedBody, 'utf8') > maxBytes) throw new Error('Media request exceeds the size limit.');
  const delivery = await sendLoopbackJsonDelivery({
    issuer, port, path, method: 'POST', fetcher: fetchLoopbackHttp, serializedBody, signal, timeoutMs: 20 * 60 * 1000,
    decision: { endpoint: path, scope: 'providers:media', capability: operationId, subject: 'provider-media',
      revision: createHash('sha256').update(serializedBody).digest('hex') },
  });
  signal.throwIfAborted();
  if (delivery.outcome !== 'response') throw new Error('Model generation outcome could not be observed; external effects may already have occurred.');
  const { status, body: result } = delivery.response;
  if (status !== 200 && isRecord(result) && result.success === false && typeof result.code === 'string'
    && typeof result.error === 'string' && result.error.length > 0 && result.error.length <= 2000) throw new Error(result.error);
  if (status !== 200) throw new Error('Model generation failed. Check the configured model and provider account.');
  return result;
}

function isPixelSizeLimits(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['step', 'maxEdge', 'minPixels', 'maxPixels', 'maxAspectRatio', 'experimentalAbovePixels'])
    || !Object.values(value).every((limit) => Number.isSafeInteger(limit) && Number(limit) > 0)) return false;
  return Number(value.step) <= Number(value.maxEdge)
    && Number(value.maxEdge) ** 2 <= Number.MAX_SAFE_INTEGER
    && Number(value.minPixels) <= Number(value.maxPixels)
    && Number(value.maxPixels) <= Number(value.maxEdge) ** 2
    && Number(value.experimentalAbovePixels) <= Number(value.maxPixels);
}

function isSelectionId(value: unknown): value is string {
  return typeof value === 'string' && /^model-selection:v1:[0-9a-f]{64}$/.test(value);
}

function isVideoTask(value: unknown): value is AppVideoTask {
  return isRecord(value) && hasExactKeys(value, ['kind', 'selectionId', 'accountId', 'modelId', 'endpointId', 'remoteId'])
    && value.kind === 'openai-video' && isSelectionId(value.selectionId)
    && typeof value.accountId === 'string' && value.accountId.length > 0 && Buffer.byteLength(value.accountId, 'utf8') <= 128
    && typeof value.modelId === 'string' && value.modelId.length > 0 && Buffer.byteLength(value.modelId, 'utf8') <= 512
    && typeof value.endpointId === 'string' && /^media-endpoint:v1:[0-9a-f]{64}$/.test(value.endpointId)
    && typeof value.remoteId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value.remoteId);
}

function validateVideoTaskRequest(request: AppVideoTaskRequest): void {
  if (!isRecord(request) || !hasExactKeys(request, ['task']) || !isVideoTask(request.task)) throw new Error('Video operations require the original provider task binding.');
}

function videoTaskOutput(result: unknown): AppVideoTaskResult {
  if (!isRecord(result) || !hasExactKeys(result, result.progress === undefined ? ['task', 'status'] : ['task', 'status', 'progress'])
    || !isVideoTask(result.task) || typeof result.status !== 'string' || !['queued', 'in-progress', 'completed', 'failed', 'unknown'].includes(result.status)
    || (result.progress !== undefined && (typeof result.progress !== 'number' || !Number.isFinite(result.progress) || result.progress < 0 || result.progress > 100))) throw new Error('The provider returned an invalid video task.');
  return result as unknown as AppVideoTaskResult;
}

function mediaOutput(result: unknown): AppModelResult {
  if (!isRecord(result) || !hasExactKeys(result, ['outputs']) || !Array.isArray(result.outputs)
    || !result.outputs.length || !result.outputs.every((output) => isRecord(output) && hasExactKeys(output, ['data', 'mimeType'])
      && typeof output.data === 'string' && typeof output.mimeType === 'string')) {
    throw new Error('Model generation failed. Check the configured model and provider account.');
  }
  return result as unknown as AppModelResult;
}
