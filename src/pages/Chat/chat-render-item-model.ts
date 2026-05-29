import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import type {
  SessionAssistantToolSegment,
  SessionAssistantTurnItem,
  SessionRenderImage,
  SessionRenderExecutionGraphItem,
  SessionRenderItem,
  SessionRenderSystemItem,
  SessionRenderUserMessageItem,
} from '../../../runtime-host/shared/session-adapter-types';

export interface ChatAssistantPresentation {
  agentId?: string;
  agentName?: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
}

interface ChatRenderItemBase {
  assistantPresentation: ChatAssistantPresentation | null;
  renderSignature: string;
}

export type ChatUserMessageItem = SessionRenderUserMessageItem & ChatRenderItemBase;
export type ChatAssistantTurnItem = SessionAssistantTurnItem & ChatRenderItemBase;
export type ChatExecutionGraphItem = SessionRenderExecutionGraphItem & ChatRenderItemBase;
export type ChatSystemItem = SessionRenderSystemItem & ChatRenderItemBase;

export type ChatRenderItem =
  | ChatUserMessageItem
  | ChatAssistantTurnItem
  | ChatExecutionGraphItem
  | ChatSystemItem;

export interface ChatAssistantCatalogAgent extends ChatAssistantPresentation {
  id: string;
}

function isSameAssistantPresentation(
  left: ChatAssistantPresentation | null,
  right: ChatAssistantPresentation | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.agentId === right.agentId
    && left.agentName === right.agentName
    && left.avatarSeed === right.avatarSeed
    && left.avatarStyle === right.avatarStyle;
}

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

function buildAttachedFilesSignature(
  attachedFiles: ReadonlyArray<{
    fileName?: string;
    filePath?: string | null;
    mimeType?: string;
    fileSize?: number;
    source?: string;
  }>,
): string {
  if (attachedFiles.length === 0) {
    return '';
  }
  const parts = attachedFiles.map((file) => [
    file.fileName ?? '',
    file.filePath ?? '',
    file.mimeType ?? '',
    String(file.fileSize ?? ''),
    file.source ?? '',
  ].join(':'));
  return hashStringDjb2(parts.join('|'));
}

function buildImageSignature(images: ReadonlyArray<SessionRenderImage>): string {
  if (images.length === 0) {
    return '';
  }
  const parts = images.map((image) => [
    image.mimeType,
    image.url ?? '',
    String(image.data?.length ?? 0),
  ].join(':'));
  return hashStringDjb2(parts.join('|'));
}

function buildAssistantToolResultSignature(result: SessionAssistantToolSegment['tool']['result']): string {
  switch (result.kind) {
    case 'text':
      return [
        result.kind,
        hashText(result.bodyText),
      ].join(':');
    case 'json':
      return [
        result.kind,
        hashText(result.bodyText),
      ].join(':');
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

function buildAssistantTurnSignature(item: SessionAssistantTurnItem): string {
  const segmentParts = item.segments.map((segment) => {
    if (segment.kind === 'message') {
      return [
        segment.kind,
        segment.key,
        hashText(segment.text),
      ].join(':');
    }
    if (segment.kind === 'thinking') {
      return [
        segment.kind,
        segment.key,
        hashText(segment.text),
      ].join(':');
    }
    if (segment.kind === 'media') {
      return [
        segment.kind,
        segment.key,
        buildImageSignature(segment.images),
        buildAttachedFilesSignature(segment.attachedFiles),
      ].join(':');
    }
    return [
      segment.kind,
      segment.key,
      segment.tool.id,
      segment.tool.toolCallId ?? '',
      segment.tool.name,
      segment.tool.status,
      String(segment.tool.updatedAt ?? ''),
      String(segment.tool.durationMs ?? ''),
      hashText(segment.tool.summary),
      buildAssistantToolResultSignature(segment.tool.result),
    ].join(':');
  });

  const toolParts = (item.tools ?? []).map((tool) => [
    tool.id,
    tool.toolCallId ?? '',
    tool.name,
    tool.status,
    String(tool.updatedAt ?? ''),
    String(tool.durationMs ?? ''),
    hashText(tool.summary),
    buildAssistantToolResultSignature(tool.result),
  ].join(':'));

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
    buildAttachedFilesSignature(item.attachedFiles ?? []),
    buildImageSignature(item.images ?? []),
    segmentParts.join('|'),
    toolParts.join('|'),
    embeddedToolResultParts.join('|'),
  ].join('|'));
}

function buildExecutionGraphSignature(item: SessionRenderExecutionGraphItem): string {
  const stepParts = item.steps.map((step) => [
    step.id,
    step.label,
    step.status,
    step.kind,
    step.detail ?? '',
    String(step.depth),
    step.parentId ?? '',
  ].join(':'));
  return hashStringDjb2([
    item.key,
    item.kind,
    item.role,
    item.createdAt ?? '',
    item.graphId,
    item.completionItemKey ?? '',
    item.childSessionKey ?? '',
    item.childSessionId ?? '',
    item.childAgentId ?? '',
    item.agentId ?? '',
    item.agentLabel ?? '',
    item.sessionLabel ?? '',
    item.anchorItemKey ?? '',
    item.triggerItemKey ?? '',
    item.replyItemKey ?? '',
    item.active ? '1' : '0',
    stepParts.join('|'),
  ].join('|'));
}

function buildRenderSignature(item: SessionRenderItem): string {
  if (item.kind === 'assistant-turn') {
    return [
      item.key,
      item.kind,
      item.role,
      item.status,
      item.createdAt ?? '',
      buildAssistantTurnSignature(item),
    ].join('|');
  }

  if (item.kind === 'execution-graph') {
    return [
      item.key,
      item.kind,
      item.role,
      item.createdAt ?? '',
      buildExecutionGraphSignature(item),
    ].join('|');
  }

  return hashStringDjb2([
    item.key,
    item.kind,
    item.role,
    item.createdAt ?? '',
    'updatedAt' in item ? (item.updatedAt ?? '') : '',
    hashText(item.text),
    'images' in item ? buildImageSignature(item.images ?? []) : '',
    'attachedFiles' in item ? buildAttachedFilesSignature(item.attachedFiles ?? []) : '',
  ].join('|'));
}

export function resolveAssistantPresentationForLaneAgentId(input: {
  agentId: string | null | undefined;
  agents: ChatAssistantCatalogAgent[];
  defaultAssistant: ChatAssistantPresentation | null;
}): ChatAssistantPresentation | null {
  const laneAgentId = typeof input.agentId === 'string' ? input.agentId.trim() : '';
  if (laneAgentId) {
    const matchedAgent = input.agents.find((agent) => agent.id === laneAgentId);
    if (matchedAgent) {
      return {
        agentId: matchedAgent.id,
        agentName: matchedAgent.agentName ?? matchedAgent.id,
        avatarSeed: matchedAgent.avatarSeed,
        avatarStyle: matchedAgent.avatarStyle,
      };
    }
    return {
      agentId: laneAgentId,
      agentName: laneAgentId,
    };
  }
  return input.defaultAssistant;
}

export function resolveItemAssistantPresentation(input: {
  item: Pick<SessionRenderItem, 'kind'> & { agentId?: string | null };
  agents: ChatAssistantCatalogAgent[];
  defaultAssistant: ChatAssistantPresentation | null;
}): ChatAssistantPresentation | null {
  if (input.item.kind !== 'assistant-turn' && input.item.kind !== 'execution-graph') {
    return null;
  }
  return resolveAssistantPresentationForLaneAgentId({
    agentId: input.item.agentId,
    agents: input.agents,
    defaultAssistant: input.defaultAssistant,
  });
}

export function applyAssistantPresentationToItems(input: {
  items: SessionRenderItem[];
  agents: ChatAssistantCatalogAgent[];
  defaultAssistant: ChatAssistantPresentation | null;
  previousItems?: ChatRenderItem[];
}): ChatRenderItem[] {
  const previousItemsByKey = new Map(
    (input.previousItems ?? []).map((item) => [item.key, item] as const),
  );
  return input.items.map((protocolItem) => {
    const renderSignature = buildRenderSignature(protocolItem);
    const assistantPresentation = resolveItemAssistantPresentation({
      item: protocolItem,
      agents: input.agents,
      defaultAssistant: input.defaultAssistant,
    });
    const previousItem = previousItemsByKey.get(protocolItem.key);
    if (
      previousItem
      && previousItem.kind === protocolItem.kind
      && previousItem.renderSignature === renderSignature
      && isSameAssistantPresentation(previousItem.assistantPresentation, assistantPresentation)
    ) {
      return previousItem;
    }
    return {
      ...protocolItem,
      renderSignature,
      assistantPresentation,
    } as ChatRenderItem;
  });
}
