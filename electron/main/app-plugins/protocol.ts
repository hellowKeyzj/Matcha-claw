import { isJsonValue } from '../runtime-host-delivery/transport/client';
import type { AppPluginManifest } from '../../../src/types/desktop/app-plugin';
import { APP_SERVICE_ERROR_CODES, APP_SERVICE_MAX_BYTES, AppServiceError, isAppServiceRequest, isAppExecutionRequest, type AppServiceErrorCode, type AppServiceRequest, type AppServiceResult, type AppExecutionRequest, type AppExecutionResult } from '../../../src/types/desktop/app-plugin-sdk';
import type { AppJson, AppMediaModelList, AppMediaModelListRequest, AppModelRequest, AppModelResult, AppMusicModelRequest, AppSpeechModelRequest, AppTranscriptionModelRequest, AppTextModelRequest, AppTextModelResult, AppVideoTaskRequest, AppVideoTaskResult, AppRuntimeEvent, AppToolResult } from '../../../src/types/desktop/app-plugin-sdk';

export interface PluginLoad {
  readonly manifest: AppPluginManifest;
  readonly digest: string;
  readonly packagePath: string;
  readonly storagePath: string;
}

export type HostRequest =
  | { type: 'activate'; requestId: string; plugin: PluginLoad }
  | { type: 'deactivate'; requestId: string; pluginId: string }
  | { type: 'call'; requestId: string; pluginId: string; digest: string; name: string; arguments: Readonly<Record<string, unknown>> }
  | { type: 'cancel'; requestId: string }
  | { type: 'execution-result'; requestId: string; pluginId: string; digest: string; result?: AppExecutionResult; error?: string; errorCode?: 'unavailable' | 'cancelled' | 'approval_unavailable' }
  | { type: 'service-result'; requestId: string; pluginId: string; digest: string; result?: AppServiceResult; error?: string; errorCode?: AppServiceErrorCode }
  | { type: 'confirmation-result'; requestId: string; result?: boolean; error?: string; errorCode?: 'approval_unavailable' }
  | { type: 'model-result'; requestId: string; result?: AppModelResult; error?: string; errorCode?: string }
  | { type: 'text-model-result'; requestId: string; result?: AppTextModelResult; error?: string; errorCode?: string }
  | { type: 'media-model-result'; requestId: string; result?: AppMediaModelList | AppVideoTaskResult | AppModelResult; error?: string; errorCode?: string };

export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; requestId: string; result?: AppToolResult; error?: string }
  | { type: 'event'; event: AppRuntimeEvent }
  | ({ type: 'execution-request'; requestId: string; pluginId: string; digest: string } & (
    | { request: Extract<AppExecutionRequest, { operation: 'resolveTeamApproval' }>; callId: string }
    | { request: Exclude<AppExecutionRequest, { operation: 'resolveTeamApproval' }>; callId?: never }))
  | { type: 'execution-cancel'; requestId: string; pluginId: string; digest: string }
  | { type: 'service-request'; requestId: string; pluginId: string; digest: string; request: AppServiceRequest }
  | { type: 'service-cancel'; requestId: string; pluginId: string; digest: string }
  | { type: 'model'; requestId: string; pluginId: string; digest: string; request: AppModelRequest }
  | { type: 'text-model'; requestId: string; pluginId: string; digest: string; request: AppTextModelRequest }
  | { type: 'media-model'; requestId: string; pluginId: string; digest: string; operation: 'generateSpeech'; request: AppSpeechModelRequest }
  | { type: 'media-model'; requestId: string; pluginId: string; digest: string; operation: 'transcribe'; request: AppTranscriptionModelRequest }
  | { type: 'media-model'; requestId: string; pluginId: string; digest: string; operation: 'generateMusic'; request: AppMusicModelRequest }
  | { type: 'media-model'; requestId: string; pluginId: string; digest: string; operation: 'list'; request: AppMediaModelListRequest }
  | { type: 'media-model'; requestId: string; pluginId: string; digest: string; operation: 'submitVideo'; request: AppModelRequest & { readonly kind: 'video' } }
  | { type: 'media-model'; requestId: string; pluginId: string; digest: string; operation: 'queryVideo' | 'collectVideo'; request: AppVideoTaskRequest }
  | { type: 'model-cancel'; requestId: string }
  | { type: 'confirmation'; requestId: string; callId: string; pluginId: string; digest: string; request: import('../../../src/types/desktop/app-plugin-sdk').AppConfirmationRequest }
  | { type: 'confirmation-cancel'; requestId: string }
  | { type: 'log'; pluginId: string; level: 'info' | 'error'; message: string };

export function isExecutionPayload(value: unknown): value is Record<string, AppJson> {
  try {
    return !!value && typeof value === 'object' && !Array.isArray(value) && isJson(value)
      && Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024;
  } catch { return false; }
}

export function isExecutionEnvelope(value: unknown): boolean {
  if (!isExecutionPayload(value) || typeof value.requestId !== 'string' || !value.requestId.length || value.requestId.length > 128
    || typeof value.pluginId !== 'string' || !value.pluginId.length || value.pluginId.length > 256
    || typeof value.digest !== 'string' || !value.digest.length || value.digest.length > 128) return false;
  const keys = ['type', 'requestId', 'pluginId', 'digest'];
  if (value.type === 'execution-request' && Object.hasOwn(value, 'request')) {
    keys.push('request');
    if (value.request && typeof value.request === 'object' && !Array.isArray(value.request) && value.request.operation === 'resolveTeamApproval') {
      if (typeof value.callId !== 'string' || !value.callId.length || value.callId.length > 128) return false;
      keys.push('callId');
    }
  } else if (value.type === 'execution-result') {
    if (typeof value.error === 'string' && value.error.length <= 2000) {
      keys.push('error');
      if (value.errorCode !== undefined) {
        if (value.errorCode !== 'unavailable' && value.errorCode !== 'cancelled' && value.errorCode !== 'approval_unavailable') return false;
        keys.push('errorCode');
      }
    } else if (Object.hasOwn(value, 'result')) keys.push('result');
    else return false;
  } else if (value.type !== 'execution-cancel') return false;
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function parseExecutionRequest(value: unknown): AppExecutionRequest {
  if (!isExecutionPayload(value) || !isAppExecutionRequest(value)) throw new Error('Invalid execution request: expected a closed JSON input within 1 MiB.');
  return value;
}

export function isServicePayload(value: unknown): value is Record<string, AppJson> {
  try {
    return !!value && typeof value === 'object' && !Array.isArray(value) && isJson(value)
      && Buffer.byteLength(JSON.stringify(value)) <= APP_SERVICE_MAX_BYTES;
  } catch { return false; }
}

export function isServiceErrorCode(value: unknown): value is AppServiceErrorCode {
  return (APP_SERVICE_ERROR_CODES as readonly unknown[]).includes(value);
}

export function serviceError(error: unknown, signal?: AbortSignal): AppServiceError {
  const code = error instanceof Error && 'code' in error && isServiceErrorCode(error.code) ? error.code
    : signal?.aborted ? 'cancelled' : 'outcome-unknown';
  return new AppServiceError(code, code === 'cancelled' || code === 'outcome-unknown'
    ? `App service request ${code}; cancellation only stops observation and external effects may already have occurred.`
    : `App service request failed (${code}).`);
}

export function isServiceEnvelope(value: unknown): boolean {
  if (!isServicePayload(value) || typeof value.requestId !== 'string' || !value.requestId.length || value.requestId.length > 128
    || typeof value.pluginId !== 'string' || !value.pluginId.length || value.pluginId.length > 256
    || typeof value.digest !== 'string' || !value.digest.length || value.digest.length > 128) return false;
  const keys = ['type', 'requestId', 'pluginId', 'digest'];
  if (value.type === 'service-request' && Object.hasOwn(value, 'request')) keys.push('request');
  else if (value.type === 'service-result') {
    if (typeof value.error === 'string' && value.error.length <= 2000 && isServiceErrorCode(value.errorCode)) keys.push('error', 'errorCode');
    else if (Object.hasOwn(value, 'result')) keys.push('result');
    else return false;
  } else if (value.type !== 'service-cancel') return false;
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function parseServiceRequest(value: unknown): AppServiceRequest {
  try {
    if (isServicePayload(value) && isAppServiceRequest(value)) return value;
  } catch { /* SDK validation must not expose input values through a thrown exception. */ }
  throw new AppServiceError('invalid-request', 'Invalid app service request: expected a closed JSON input within 8 MiB.');
}

export function isModelErrorCode(value: unknown): value is string {
  return typeof value === 'string' && ['invalid-request', 'selection-unavailable', 'unsupported', 'credential-missing',
    'credential-unavailable', 'authentication', 'permission-denied', 'rate-limited', 'deadline', 'cancelled',
    'response-too-large', 'invalid-response', 'generation-failed', 'provider-unavailable', 'owner-unavailable',
    'task-binding-changed', 'unauthorized'].includes(value);
}

export function toolError(message: string): AppToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function isJson(value: unknown): value is AppJson {
  return isJsonValue(value, new Set());
}

export function isToolResult(value: unknown): value is AppToolResult {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !isJson(value)) return false;
  const result = value as Record<string, unknown>;
  return Array.isArray(result.content)
    && result.content.every((block) => block && typeof block === 'object' && !Array.isArray(block) && typeof block.type === 'string')
    && (result.isError === undefined || typeof result.isError === 'boolean')
    && (result.structuredContent === undefined || (!!result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)))
    && (result._meta === undefined || (!!result._meta && typeof result._meta === 'object' && !Array.isArray(result._meta)));
}
