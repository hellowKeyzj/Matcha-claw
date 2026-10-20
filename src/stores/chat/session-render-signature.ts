import type { SessionAssistantTurnItem, SessionExecutionGraphStep, SessionRenderExecutionGraphItem, SessionRenderItem, SessionRenderSystemItem } from '../../types/session/render-item';
import type { SessionRenderAttachedFile, SessionRenderImage, SessionRenderToolCard } from '../../types/session/tool-card';
import { isControlledSessionRenderItem, isControlledSessionRenderTool } from './session-render-projection';
import { isSessionProjectionFact, stringifySessionToolPayload } from './session-projection-facts';

type SignaturePurpose = 'reconciliation' | 'display';

// Only owner-certified immutable objects may survive across calls; all keys remain weak.
const reconciliationToolSignatures = new WeakMap<SessionRenderToolCard, string>();
const displayToolSignatures = new WeakMap<SessionRenderToolCard, string>();
const reconciliationItemSignatures = new WeakMap<SessionRenderItem, string>();
const displayItemSignatures = new WeakMap<SessionRenderItem, string>();
const payloadSignatures = new WeakMap<object, string>();

function hashStringDjb2(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function hashText(value: string | null | undefined): string {
  return hashStringDjb2(value ?? '');
}

function largeTextSignature(value: { contentRef: string; totalBytes: number; loadedBytes: number } | null | undefined): string {
  return value ? `${value.contentRef}:${value.loadedBytes}:${value.totalBytes}` : '';
}

function buildAttachedFilesSignature(attachedFiles: ReadonlyArray<SessionRenderAttachedFile>, purpose: SignaturePurpose): string {
  if (attachedFiles.length === 0) return '';
  const parts = attachedFiles.map((file) => [
    purpose === 'display' ? file.fileName ?? '' : file.fileName,
    file.filePath ?? '',
    file.gatewayUrl ?? '',
    purpose === 'display' ? file.mimeType ?? '' : file.mimeType,
    purpose === 'display' ? String(file.fileSize ?? '') : String(file.fileSize),
    file.preview ?? '',
    file.previewStatus ?? '',
    file.attachmentStatus ?? '',
    file.source ?? '',
  ].join(':'));
  return hashStringDjb2(parts.join('|'));
}

function buildImageSignature(images: ReadonlyArray<SessionRenderImage>): string {
  if (images.length === 0) return '';
  const parts = images.map((image) => [
    image.mimeType,
    image.url ?? '',
    String(image.data?.length ?? 0),
  ].join(':'));
  return hashStringDjb2(parts.join('|'));
}

function toolPayloadSignature(value: unknown, purpose: SignaturePurpose): string {
  if (purpose === 'display') {
    if (value === null || value === undefined) return '';
    return hashText(typeof value === 'string' ? value : JSON.stringify(value));
  }
  if (!isSessionProjectionFact(value)) return hashText(stringifySessionToolPayload(value));
  const fact = value as object;
  let signature = payloadSignatures.get(fact);
  if (signature === undefined) {
    signature = hashText(stringifySessionToolPayload(value, true));
    payloadSignatures.set(fact, signature);
  }
  return signature;
}

function buildAssistantToolResultSignature(result: SessionRenderToolCard['result'], purpose: SignaturePurpose): string {
  switch (result.kind) {
    case 'text':
    case 'json':
      return purpose === 'reconciliation'
        ? `${result.kind}:${hashText(result.bodyText)}`
        : [result.kind, hashText(result.bodyText)].join(':');
    case 'canvas':
      return [
        result.kind,
        result.surface,
        result.preview.kind,
        result.preview.surface,
        result.preview.viewId,
        hashText(result.rawText),
      ].join(':');
    default:
      return result.kind;
  }
}

// Display's dynamic segment.tool is read once per field; reconciliation captures it once.
// Keep the reader and the final join separate to preserve getter/coercion order.
function buildToolSignatureParts(readTool: () => SessionRenderToolCard, purpose: SignaturePurpose) {
  return [
    readTool().id,
    readTool().toolCallId ?? '',
    readTool().name,
    readTool().runtimeAdapterId ?? '',
    readTool().status,
    String(readTool().updatedAt ?? ''),
    String(readTool().durationMs ?? ''),
    toolPayloadSignature(readTool().input, purpose),
    hashText(readTool().inputText),
    toolPayloadSignature(readTool().output, purpose),
    toolPayloadSignature(readTool().details, purpose),
    hashText(readTool().summary),
    buildAssistantToolResultSignature(readTool().result, purpose),
  ];
}

function buildToolSignature(tool: SessionRenderToolCard, purpose: SignaturePurpose): string {
  const controlled = purpose === 'reconciliation' ? isSessionProjectionFact(tool) : isControlledSessionRenderTool(tool);
  const signatures = purpose === 'reconciliation' ? reconciliationToolSignatures : displayToolSignatures;
  const cached = controlled ? signatures.get(tool) : undefined;
  if (cached !== undefined) return cached;
  const signature = buildToolSignatureParts(() => tool, purpose).join(':');
  if (controlled) signatures.set(tool, signature);
  return signature;
}

function buildAssistantTurnSignature(item: SessionAssistantTurnItem, purpose: SignaturePurpose): string {
  const controlled = purpose === 'display' && isControlledSessionRenderItem(item);
  const segmentParts = item.segments.map((segment) => {
    if (segment.kind === 'message') {
      // Template coercion precedes later getters; display's array join follows them.
      return purpose === 'reconciliation'
        ? `${segment.kind}:${segment.key}:${hashText(segment.text)}:${largeTextSignature(segment.largeText)}`
        : [segment.kind, segment.key, hashText(segment.text), largeTextSignature(segment.largeText)].join(':');
    }
    if (segment.kind === 'thinking') {
      return purpose === 'reconciliation'
        ? `${segment.kind}:${segment.key}:${hashText(segment.text)}`
        : [segment.kind, segment.key, hashText(segment.text)].join(':');
    }
    if (segment.kind === 'media') {
      return [
        segment.kind,
        segment.key,
        buildImageSignature(segment.images),
        buildAttachedFilesSignature(segment.attachedFiles, purpose),
      ].join(':');
    }
    if (purpose === 'reconciliation' || controlled) {
      return [segment.kind, segment.key, buildToolSignature(segment.tool, purpose)].join(':');
    }
    return [segment.kind, segment.key, ...buildToolSignatureParts(() => segment.tool, purpose)].join(':');
  });

  const toolParts = (purpose === 'reconciliation' ? item.tools : item.tools ?? [])
    .map((tool) => buildToolSignature(tool, purpose));
  const embeddedToolResultParts = (item.embeddedToolResults ?? []).map((result) => [
    result.key,
    result.toolCallId ?? '',
    result.toolName,
    result.preview.kind,
    result.preview.viewId,
    result.rawText ? hashText(result.rawText) : '',
  ].join(':'));

  return hashStringDjb2([
    item.key,
    item.kind,
    item.role,
    item.status,
    item.createdAt ?? '',
    item.updatedAt ?? '',
    item.turnKey ?? '',
    item.laneKey ?? '',
    item.agentId ?? '',
    item.pendingState ?? '',
    hashText(item.text),
    ...(purpose === 'reconciliation' ? [
      buildImageSignature(item.images),
      buildAttachedFilesSignature(item.attachedFiles, purpose),
    ] : [
      buildAttachedFilesSignature(item.attachedFiles ?? [], purpose),
      buildImageSignature(item.images ?? []),
    ]),
    segmentParts.join('|'),
    toolParts.join('|'),
    embeddedToolResultParts.join('|'),
  ].join('|'));
}

function buildExecutionGraphStepSignature(step: SessionExecutionGraphStep): string {
  return [
    step.id,
    step.label,
    step.status,
    step.kind,
    step.detail ?? '',
    String(step.depth),
    step.parentId ?? '',
  ].join(':');
}

function buildExecutionGraphSignature(item: SessionRenderExecutionGraphItem, purpose: SignaturePurpose): string {
  // Display reads steps before graph fields; reconciliation reads them after.
  const stepParts = purpose === 'display' ? item.steps.map(buildExecutionGraphStepSignature) : null;
  return hashStringDjb2([
    item.key,
    item.kind,
    item.role,
    item.createdAt ?? '',
    item.graphId,
    item.completionItemKey,
    ...(purpose === 'reconciliation' ? [item.anchorItemKey ?? ''] : []),
    item.childSessionKey,
    item.childSessionId ?? '',
    item.childAgentId ?? '',
    item.agentId ?? '',
    item.agentLabel,
    item.sessionLabel,
    ...(purpose === 'display' ? [item.anchorItemKey ?? ''] : []),
    item.triggerItemKey ?? '',
    item.replyItemKey ?? '',
    item.active ? '1' : '0',
    purpose === 'display' ? stepParts!.join('|') : item.steps.map(buildExecutionGraphStepSignature).join('|'),
  ].join('|'));
}

function computeItemSignature(item: SessionRenderItem, purpose: SignaturePurpose): string {
  if (item.kind === 'assistant-turn') {
    if (purpose === 'reconciliation') return buildAssistantTurnSignature(item, purpose);
    return [
      item.key,
      item.kind,
      item.role,
      item.status,
      item.createdAt ?? '',
      buildAssistantTurnSignature(item, purpose),
    ].join('|');
  }
  if (item.kind === 'execution-graph') {
    if (purpose === 'reconciliation') return buildExecutionGraphSignature(item, purpose);
    return [
      item.key,
      item.kind,
      item.role,
      item.createdAt ?? '',
      buildExecutionGraphSignature(item, purpose),
    ].join('|');
  }
  if (purpose === 'display') {
    return hashStringDjb2([
      item.key,
      item.kind,
      item.role,
      item.createdAt ?? '',
      'updatedAt' in item ? (item.updatedAt ?? '') : '',
      'clientId' in item ? (item.clientId ?? '') : '',
      'status' in item ? (item.status ?? '') : '',
      hashText(item.text),
      'largeText' in item ? largeTextSignature(item.largeText) : '',
      'images' in item ? buildImageSignature(item.images ?? []) : '',
      'attachedFiles' in item ? buildAttachedFilesSignature(item.attachedFiles ?? [], purpose) : '',
    ].join('|'));
  }
  if (item.kind === 'user-message') {
    return hashStringDjb2([
      item.key,
      item.kind,
      item.role,
      item.messageId ?? '',
      item.clientId ?? '',
      item.status ?? '',
      item.createdAt ?? '',
      item.updatedAt ?? '',
      hashText(item.text),
      largeTextSignature(item.largeText),
      buildImageSignature(item.images),
      buildAttachedFilesSignature(item.attachedFiles, purpose),
    ].join('|'));
  }
  const systemItem: SessionRenderSystemItem = item;
  return hashStringDjb2([
    systemItem.key,
    systemItem.kind,
    systemItem.role,
    systemItem.createdAt ?? '',
    systemItem.level,
    hashText(systemItem.text),
  ].join('|'));
}

function buildItemSignature(item: SessionRenderItem, purpose: SignaturePurpose): string {
  const controlled = isControlledSessionRenderItem(item);
  const signatures = purpose === 'reconciliation' ? reconciliationItemSignatures : displayItemSignatures;
  const cached = controlled ? signatures.get(item) : undefined;
  if (cached !== undefined) return cached;
  const signature = computeItemSignature(item, purpose);
  if (controlled) signatures.set(item, signature);
  return signature;
}

export function buildSessionItemReconciliationSignature(item: SessionRenderItem): string {
  return buildItemSignature(item, 'reconciliation');
}

export function buildSessionItemDisplaySignature(item: SessionRenderItem): string {
  return buildItemSignature(item, 'display');
}

export function buildItemRenderFingerprint(items: SessionRenderItem[]): string {
  if (items.length === 0) return hashStringDjb2('0');
  return hashStringDjb2(items.map(buildSessionItemReconciliationSignature).join('|'));
}
