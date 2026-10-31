import { isJsonValue } from '../runtime-host-delivery/transport/client';
import type { AppPluginManifest } from '../../../src/types/desktop/app-plugin';
import type { AppJson, AppMediaModelList, AppMediaModelListRequest, AppModelRequest, AppModelResult, AppTextModelRequest, AppTextModelResult, AppVideoTaskRequest, AppVideoTaskResult, AppRuntimeEvent, AppToolResult } from '../../../src/types/desktop/app-plugin-sdk';

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
  | { type: 'model-result'; requestId: string; result?: AppModelResult; error?: string }
  | { type: 'text-model-result'; requestId: string; result?: AppTextModelResult; error?: string }
  | { type: 'media-model-result'; requestId: string; result?: AppMediaModelList | AppVideoTaskResult | AppModelResult; error?: string };

export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; requestId: string; result?: AppToolResult; error?: string }
  | { type: 'event'; event: AppRuntimeEvent }
  | { type: 'model'; requestId: string; pluginId: string; digest: string; request: AppModelRequest }
  | { type: 'text-model'; requestId: string; pluginId: string; digest: string; request: AppTextModelRequest }
  | { type: 'media-model'; requestId: string; pluginId: string; digest: string; operation: 'list'; request: AppMediaModelListRequest }
  | { type: 'media-model'; requestId: string; pluginId: string; digest: string; operation: 'submitVideo'; request: AppModelRequest & { readonly kind: 'video' } }
  | { type: 'media-model'; requestId: string; pluginId: string; digest: string; operation: 'queryVideo' | 'collectVideo'; request: AppVideoTaskRequest }
  | { type: 'model-cancel'; requestId: string }
  | { type: 'log'; pluginId: string; level: 'info' | 'error'; message: string };

export function toolError(message: string): AppToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function isJson(value: unknown): value is AppJson {
  return isJsonValue(value, new Set());
}
