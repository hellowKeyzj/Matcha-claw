import { setTimeout } from 'node:timers/promises';
import type { AppModelRequest, AppPluginContext, AppVideoTaskResult } from '../../../../src/types/desktop/app-plugin-sdk';
import type { Asset } from '../document';
import type { Assets } from './assets';
import { DesignError } from './files';
import type { GenerationSnapshot } from './generation-snapshot';

type Save = (snapshot: GenerationSnapshot) => Promise<void>;

export async function generateVideoScene(
  context: AppPluginContext, assets: Assets, snapshot: GenerationSnapshot, sceneIndex: number,
  request: AppModelRequest & { kind: 'video' } | undefined, signal: AbortSignal, save: Save,
): Promise<Asset[]> {
  let entry = snapshot.videoTasks?.find((entry) => entry.sceneIndex === sceneIndex);
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(20 * 60 * 1000)]);
  if (!entry) {
    if (!request) throw new DesignError('interrupted', 'No persisted task receipt exists for this scene. It was not submitted again because the provider may already have charged or created a task.');
    const submitted = await context.models.submitVideo(request, bounded);
    entry = { sceneIndex, task: submitted.task, status: submitted.status, assetIds: [] };
    (snapshot.videoTasks ??= []).push(entry);
    await save(snapshot);
  }
  if (entry.assetIds.length) {
    const saved = await Promise.all(entry.assetIds.map((assetId) => assets.get(assetId)));
    if (saved.some((asset) => !asset.mimeType.startsWith('video/'))) throw new Error('The saved video task output is not video media. It was retained and not collected again.');
    return saved;
  }
  const task = entry.task;
  function applyQuery(result: AppVideoTaskResult): void {
    if ((['kind', 'selectionId', 'accountId', 'modelId', 'endpointId', 'remoteId'] as const).some((field) => result.task[field] !== task[field])) throw new Error('The provider returned a different video task receipt.');
    entry!.status = result.status;
  }
  if (!request) {
    applyQuery(await context.models.queryVideo({ task }, bounded));
    await save(snapshot);
  }
  while (entry.status !== 'completed') {
    bounded.throwIfAborted();
    if (entry.status === 'failed') throw new DesignError('video_task_failed', 'The provider video task failed. The existing task receipt was saved and the request was not submitted again.');
    await setTimeout(2000, undefined, { signal: bounded });
    const previous = entry.status;
    applyQuery(await context.models.queryVideo({ task }, bounded));
    if (previous !== entry.status) await save(snapshot);
  }
  const result = await context.models.collectVideo({ task }, bounded);
  if (!result.outputs.length || result.outputs.length > 8) throw new Error('The completed video task returned an invalid number of media outputs.');
  const imported: Asset[] = [];
  for (let index = 0; index < result.outputs.length; index++) {
    bounded.throwIfAborted();
    const output = result.outputs[index];
    const asset = await assets.importBase64(`${snapshot.request.action}-${sceneIndex + 1}-${index + 1}`, output.mimeType, output.data, bounded);
    snapshot.record.assets.push(asset);
    entry.assetIds.push(asset.id);
    imported.push(asset);
    await save(snapshot);
  }
  if (imported.some((asset) => !asset.mimeType.startsWith('video/'))) throw new Error('The video task returned unexpected media. All returned assets have been saved.');
  return imported;
}
