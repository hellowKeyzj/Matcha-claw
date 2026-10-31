import { basename } from 'node:path';
import type { AppVideoTask, AppVideoTaskResult } from '../../../../src/types/desktop/app-plugin-sdk';
import type { Asset, GenerationEditing, GenerationRecord, GenerationRequest } from '../document';
import { readJson } from './files';
import { dimensions, generationActions, generationRequest, id, ids, invalid, number, object, text } from './validation';

export interface GenerationSnapshot {
  formatVersion: 1;
  request: GenerationRequest;
  sourceRevision: number;
  inputAssetIds: string[];
  record: GenerationRecord;
  videoTasks?: { sceneIndex: number; task: AppVideoTask; status: AppVideoTaskResult['status']; assetIds: string[] }[];
  outputAssetIds?: string[];
  outputLayerIds?: string[];
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field, 100);
  if (!Number.isFinite(Date.parse(result))) invalid(`Invalid ${field}.`);
  return result;
}

function asset(value: unknown): Asset {
  const raw = object(value, ['id', 'name', 'mimeType', 'width', 'height', 'durationSeconds', 'posterAssetId', 'contentHash']);
  id(raw.id); text(raw.name, 'asset name', 200);
  const mimeType = text(raw.mimeType, 'asset mimeType', 100);
  if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/')) invalid('Generation asset must be an image or video.');
  if (raw.width !== undefined || raw.height !== undefined || mimeType.startsWith('image/')) dimensions(raw.width as number, raw.height as number);
  if (raw.durationSeconds !== undefined) {
    if (!mimeType.startsWith('video/')) invalid('Only video assets may contain durationSeconds.');
    number(raw.durationSeconds, 'durationSeconds', Number.MIN_VALUE, Number.MAX_SAFE_INTEGER);
  }
  if (raw.posterAssetId !== undefined) {
    if (!mimeType.startsWith('video/') || raw.posterAssetId === raw.id) invalid('Invalid generation video poster.');
    id(raw.posterAssetId, 'posterAssetId');
  }
  if (raw.contentHash !== undefined && (typeof raw.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.contentHash))) invalid('Invalid asset contentHash.');
  return raw as unknown as Asset;
}

function editing(value: unknown, request: GenerationRequest, sourceCount: number): GenerationEditing {
  const raw = object(value, ['selectionId', 'size', 'durationSeconds', 'scenes', 'referenceAssetIds']);
  if (raw.selectionId !== undefined && (typeof raw.selectionId !== 'string' || !/^model-selection:v1:[a-f0-9]{64}$/.test(raw.selectionId))) invalid('Invalid generation editing selectionId.');
  if (raw.size !== undefined) text(raw.size, 'editing size', 100);
  if (raw.durationSeconds !== undefined) {
    if (request.action !== 'video') invalid('Editing durationSeconds is only valid for video.');
    number(raw.durationSeconds, 'editing durationSeconds', 1, 120);
  }
  let scenes: GenerationEditing['scenes'];
  if (raw.scenes !== undefined) {
    if (request.action !== 'storyboard' || !Array.isArray(raw.scenes) || !raw.scenes.length || raw.scenes.length > 24) invalid('Invalid editing storyboard scenes.');
    scenes = raw.scenes.map((value) => {
      const scene = object(value, ['prompt', 'durationSeconds']);
      return { prompt: text(scene.prompt, 'editing scene prompt', 20000),
        ...(scene.durationSeconds === undefined ? {} : { durationSeconds: number(scene.durationSeconds, 'editing scene durationSeconds', 1, 120) }) };
    });
  }
  let referenceAssetIds: string[] | undefined;
  if (raw.referenceAssetIds !== undefined) {
    if (request.action !== 'video' && request.action !== 'storyboard') invalid('Editing referenceAssetIds is only valid for video or storyboard.');
    referenceAssetIds = ids(raw.referenceAssetIds, 'editing referenceAssetIds', 16);
    if (sourceCount + referenceAssetIds.length > 16) invalid('Editing source and reference images exceed 16.');
  }
  return { ...(raw.selectionId === undefined ? {} : { selectionId: raw.selectionId as string }),
    ...(raw.size === undefined ? {} : { size: raw.size as string }),
    ...(raw.durationSeconds === undefined ? {} : { durationSeconds: raw.durationSeconds as number }),
    ...(scenes === undefined ? {} : { scenes }), ...(referenceAssetIds === undefined ? {} : { referenceAssetIds }) };
}

export function validateGenerationPlacements(value: unknown): void {
  if (!Array.isArray(value) || value.length > 8) invalid('Invalid generation placements.');
  for (const entry of value) {
    const placement = object(entry, ['x', 'y', 'width', 'height']);
    number(placement.x, 'placement x', -1000000, 1000000); number(placement.y, 'placement y', -1000000, 1000000);
    number(placement.width, 'placement width', 0.01, 32768); number(placement.height, 'placement height', 0.01, 32768);
  }
}

export async function loadGenerationSnapshot(path: string): Promise<GenerationSnapshot> {
  const raw = object(await readJson(path), ['formatVersion', 'request', 'sourceRevision', 'inputAssetIds', 'record', 'videoTasks', 'outputAssetIds', 'outputLayerIds']);
  if (raw.formatVersion !== 1) invalid('Invalid generation snapshot version.');
  const request = generationRequest(raw.request, true);
  const record = object(raw.record, ['id', 'documentId', 'action', 'prompt', 'state', 'sourceLayerIds', 'editing', 'placements', 'assets', 'startedAt', 'finishedAt', 'error']);
  id(record.id); id(record.documentId, 'documentId');
  if (record.id !== basename(path, '.json') || record.documentId !== request.documentId || record.action !== request.action || record.prompt !== request.prompt
    || !generationActions.includes(record.action as GenerationRecord['action'])
    || !['running', 'completed', 'failed', 'interrupted', 'cancelled'].includes(String(record.state))) invalid('Invalid generation snapshot identity or state.');
  text(record.prompt, 'prompt', 20000, true);
  timestamp(record.startedAt, 'startedAt');
  if (record.finishedAt !== undefined) timestamp(record.finishedAt, 'finishedAt');
  if ((record.state === 'running') !== (record.finishedAt === undefined)) invalid('Generation state and finishedAt disagree.');
  if (record.error !== undefined) text(record.error, 'generation error', Number.MAX_SAFE_INTEGER, true);
  const sourceLayerIds = record.sourceLayerIds === undefined ? [] : ids(record.sourceLayerIds, 'sourceLayerIds', 16);
  const checkedEditing = record.editing === undefined ? undefined : editing(record.editing, request, sourceLayerIds.length);
  if (record.placements !== undefined) validateGenerationPlacements(record.placements);
  if (!Array.isArray(record.assets)) invalid('Invalid generation asset list.');
  const assets = record.assets.map(asset);
  if (new Set(assets.map((entry) => entry.id)).size !== assets.length) invalid('Duplicate generation asset IDs.');
  let videoTasks: GenerationSnapshot['videoTasks'];
  if (raw.videoTasks !== undefined) {
    const sceneCount = request.action === 'storyboard' ? request.scenes!.length : 1;
    if ((request.action !== 'video' && request.action !== 'storyboard') || !Array.isArray(raw.videoTasks) || raw.videoTasks.length > sceneCount) invalid('Invalid generation videoTasks.');
    videoTasks = raw.videoTasks.map((value) => {
      const entry = object(value, ['sceneIndex', 'task', 'status', 'assetIds']);
      const task = object(entry.task, ['kind', 'selectionId', 'accountId', 'modelId', 'endpointId', 'remoteId']);
      if (task.kind !== 'openai-video' || !['queued', 'in-progress', 'completed', 'failed', 'unknown'].includes(String(entry.status))) invalid('Invalid video task receipt.');
      for (const field of ['selectionId', 'accountId', 'modelId', 'endpointId', 'remoteId']) text(task[field], `task ${field}`, 500);
      const assetIds = ids(entry.assetIds, 'video task assetIds', 8);
      if (assetIds.some((assetId) => !assets.some((asset) => asset.id === assetId))) invalid('Video task references an unsaved output asset.');
      return { sceneIndex: number(entry.sceneIndex, 'sceneIndex', 0, sceneCount - 1, true), task: task as unknown as AppVideoTask,
        status: entry.status as AppVideoTaskResult['status'], assetIds };
    });
    if (new Set(videoTasks.map((entry) => entry.sceneIndex)).size !== videoTasks.length) invalid('Duplicate video scene task receipts.');
  }
  const outputAssetIds = raw.outputAssetIds === undefined ? undefined : ids(raw.outputAssetIds, 'outputAssetIds', 8);
  const outputLayerIds = raw.outputLayerIds === undefined ? undefined : ids(raw.outputLayerIds, 'outputLayerIds', 8);
  if (outputAssetIds && outputAssetIds.some((assetId) => !assets.some((asset) => asset.id === assetId))) invalid('Output receipt references an unsaved asset.');
  if ((outputAssetIds === undefined) !== (outputLayerIds === undefined) || (outputAssetIds && outputAssetIds.length !== outputLayerIds!.length)) invalid('Output asset and layer receipts disagree.');
  if (!Array.isArray(raw.inputAssetIds) || raw.inputAssetIds.length > 16) invalid('Invalid generation inputAssetIds.');
  return { formatVersion: 1, request, sourceRevision: number(raw.sourceRevision, 'sourceRevision', 0, Number.MAX_SAFE_INTEGER, true),
    inputAssetIds: raw.inputAssetIds.map((value) => id(value, 'inputAssetId')), record: { ...record, assets, ...(checkedEditing === undefined ? {} : { editing: checkedEditing }) } as unknown as GenerationRecord,
    ...(videoTasks === undefined ? {} : { videoTasks }), ...(outputAssetIds === undefined ? {} : { outputAssetIds, outputLayerIds }) };
}
