import { useContributions } from '@/plugin-host/react';
import { isControlledSessionRenderTool } from '@/plugins/chat/store/session-render-projection';
import { messageParts, resolveMessagePartRenderer } from '@/plugins/message-rendering/extensions';
import { Suspense, useCallback, useEffect, useMemo, useState, memo, useReducer, type ReactNode } from 'react';
import type { ChatAssistantTurnItem } from '@/plugins/message-rendering/chat-render-item-model';
import { buildToolGroupPlan, isCoveredToolOnlyItem } from '@/plugins/chat/tool-group-plan';
import type { ToolSlot } from '@/plugins/message-rendering/tool-groups';
import type { ToolActivityDisclosure } from '@/plugins/message-rendering/tool-renderers/types';
import { useToolActivityDisclosure } from '@/plugins/message-rendering/useToolActivityDisclosure';
import type { AttachedFileMeta } from '@/plugins/message-rendering/attachments';
import { MessageShell, type MessageAvatarSlot } from '@/plugins/message-rendering/chat-message-shell';
import { ChatImageLightbox } from '@/plugins/message-rendering/ChatImageLightbox';
import { AssistantPendingIndicator } from '@/plugins/chat/components/AssistantPendingIndicator';
import { getAssistantTurnPlainText } from '@/plugins/message-rendering/chat-message-view';
import {
  AssistantMessageMetaBar,
  type MessageLightboxState,
} from '@/plugins/message-rendering/chat-message-parts';
import type { SessionRenderToolCard } from '@/types/session/tool-card';
import { isOpenClawTool, readBrowserTabPreview } from '@/plugins/message-rendering/tool-renderers/openclaw-details';
import { buildToolRuntimeSurface } from '@/plugins/message-rendering/tool-activity-view-model';
import { isOpenClawSurfaceSessionIdentity } from '@/types/openclaw-runtime-surface';
import { openChatRuntimeSurface, type ChatRuntimeSurfaceDescriptor } from '@/plugins/surfaces/chat/runtime-surfaces';
import { useArtifactRefExtractor } from '@/plugins/chat/artifact-paths';
import { createAttachedMediaMatcher } from '@/plugins/message-rendering/md-link';
import { getSessionTextModel, type SessionTextModel } from '@/plugins/chat/store/session-presentation';
import type { WorkspaceFileContext } from '@/lib/host-api';
import { isSessionTraceEnabled, logSessionTrace, summarizeIdentifier, summarizeRenderItem, summarizeSessionIdentity, summarizeText } from '@/lib/session-trace';
import { validateSessionIdentity, type SessionIdentity } from '@/types/desktop/runtime-address';
import {
  containsTodoToolDebugSignal,
  logRendererTodoToolDebug,
  summarizeAssistantTurnForTodoToolDebug,
} from '@/plugins/chat/store/todo-tool-debug';

interface ChatAssistantTurnProps {
  item: ChatAssistantTurnItem;
  toolSlots?: ReadonlyMap<string, ToolSlot>;
  latestBrowserTools?: ReadonlySet<SessionRenderToolCard>;
  disclosure?: ToolActivityDisclosure;
  showThinking: boolean;
  replyStartedAt?: number;
  assistantAvatarSlot?: MessageAvatarSlot;
  userAvatarImageUrl?: string | null;
  sessionIdentity?: SessionIdentity;
  endpointSessionId?: string | null;
  workspaceContext?: WorkspaceFileContext;
  onOpenAttachedArtifact?: (file: AttachedFileMeta) => boolean | void;
  onRuntimeSendMessage?: (text: string) => void | Promise<void>;
  onRuntimeOpenLink?: (url: string) => void | Promise<void>;
}

type MarkdownFenceState = {
  marker: '`' | '~';
  length: number;
} | null;

function readFenceMarker(line: string): { marker: '`' | '~'; length: number; closingOnly: boolean } | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) {
    return null;
  }
  const fence = match[1] ?? '';
  const rest = match[2] ?? '';
  const marker = fence[0] === '~' ? '~' : '`';
  return {
    marker,
    length: fence.length,
    closingOnly: rest.trim().length === 0,
  };
}

function advanceMarkdownFenceState(text: string, initialState: MarkdownFenceState): MarkdownFenceState {
  let state = initialState;
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const fence = readFenceMarker(line);
    if (!fence) {
      continue;
    }
    if (state) {
      if (fence.marker === state.marker && fence.length >= state.length && fence.closingOnly) {
        state = null;
      }
      continue;
    }
    state = {
      marker: fence.marker,
      length: fence.length,
    };
  }
  return state;
}

function removeLeadingFenceClose(text: string, state: MarkdownFenceState): string {
  if (!state) {
    return text;
  }
  const match = /^(?: {0,3})(`{3,}|~{3,})[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) {
    return text;
  }
  const fence = match[1] ?? '';
  const marker = fence[0] === '~' ? '~' : '`';
  if (marker !== state.marker || fence.length < state.length) {
    return text;
  }
  return text.slice(match[0].length);
}

function buildMessageSegmentRenderTextByKey(item: ChatAssistantTurnItem, textModel: SessionTextModel): Map<string, string> {
  const renderTextByKey = new Map<string, string>();
  let fenceState: MarkdownFenceState = null;
  for (const segment of item.segments) {
    if (segment.kind !== 'message') {
      continue;
    }
    const renderText = textModel.assistant(removeLeadingFenceClose(segment.text, fenceState));
    renderTextByKey.set(segment.key, renderText);
    fenceState = advanceMarkdownFenceState(segment.text, fenceState);
  }
  return renderTextByKey;
}

function buildRuntimeSurfaceDescriptor(tool: SessionRenderToolCard, sessionIdentity: SessionIdentity): ChatRuntimeSurfaceDescriptor | null {
  if (!isOpenClawTool(tool) || !isOpenClawSurfaceSessionIdentity(sessionIdentity)) return null;
  const browserTab = tool.name === 'browser' && tool.status === 'completed' ? readBrowserTabPreview(tool.details) : undefined;
  if (browserTab) return { ...browserTab, sourceSessionIdentity: sessionIdentity };
  return buildToolRuntimeSurface(tool, sessionIdentity) ?? null;
}

function openToolSurface(tool: SessionRenderToolCard, sessionIdentity: SessionIdentity): void {
  const descriptor = buildRuntimeSurfaceDescriptor(tool, sessionIdentity);
  if (descriptor) openChatRuntimeSurface(descriptor);
}

function isActiveReplyStatus(status: ChatAssistantTurnItem['status']): boolean {
  return status === 'streaming' || status === 'waiting_tool';
}

function resolveReplyDurationEndAt(item: ChatAssistantTurnItem, now: number): number | undefined {
  if (isActiveReplyStatus(item.status)) {
    return now;
  }
  if (item.status === 'final' || item.status === 'error' || item.status === 'aborted') {
    return item.updatedAt ?? item.createdAt;
  }
  return undefined;
}

function formatReplyDurationSeconds(durationMs: number): string | undefined {
  if (!Number.isFinite(durationMs) || durationMs < 1000) {
    return undefined;
  }
  return `${Math.floor(durationMs / 1000)}秒`;
}

function getReplyDurationLabel(input: {
  item: ChatAssistantTurnItem;
  replyStartedAt?: number;
  now: number;
}): string | undefined {
  const startedAt = input.replyStartedAt;
  const endedAt = resolveReplyDurationEndAt(input.item, input.now);
  if (typeof startedAt !== 'number' || typeof endedAt !== 'number') {
    return undefined;
  }
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    return undefined;
  }
  if (endedAt < startedAt) {
    return undefined;
  }
  const durationLabel = formatReplyDurationSeconds(endedAt - startedAt);
  if (!durationLabel) {
    return undefined;
  }
  return isActiveReplyStatus(input.item.status) ? `等待响应… ${durationLabel}` : `已完成，耗时 ${durationLabel}`;
}

function AssistantTurnShell({
  item,
  replyStartedAt,
  assistantAvatarSlot,
  userAvatarImageUrl,
  plainText,
  visible,
  children,
}: Pick<ChatAssistantTurnProps, 'item' | 'replyStartedAt' | 'assistantAvatarSlot' | 'userAvatarImageUrl'> & {
  plainText: string;
  visible: boolean;
  children?: ReactNode;
}) {
  const [now, setNow] = useState(() => Date.now());
  const isStreaming = isActiveReplyStatus(item.status);
  const replyDurationLabel = getReplyDurationLabel({ item, replyStartedAt, now });

  useEffect(() => {
    if (!isStreaming || typeof replyStartedAt !== 'number') {
      return;
    }
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [isStreaming, replyStartedAt]);

  // Keep the clock mounted while the turn has no visible content.
  if (!visible) return null;

  return (
    <MessageShell
      isUser={false}
      assistantAgentId={item.assistantPresentation?.agentId}
      assistantAgentName={item.assistantPresentation?.agentName}
      assistantAvatarSeed={item.assistantPresentation?.avatarSeed}
      assistantAvatarStyle={item.assistantPresentation?.avatarStyle}
      assistantAvatarSlot={assistantAvatarSlot}
      userAvatarImageUrl={userAvatarImageUrl}
    >
      {children}
      {(plainText || replyDurationLabel) ? (
        <AssistantMessageMetaBar text={plainText} timestamp={item.createdAt} statusLabel={replyDurationLabel} />
      ) : null}
    </MessageShell>
  );
}

export const ChatAssistantTurn = memo(function ChatAssistantTurn({
  item,
  toolSlots,
  latestBrowserTools,
  disclosure: sharedDisclosure,
  showThinking,
  replyStartedAt,
  assistantAvatarSlot,
  userAvatarImageUrl,
  sessionIdentity,
  endpointSessionId,
  onOpenAttachedArtifact,
  onRuntimeSendMessage,
  onRuntimeOpenLink,
}: ChatAssistantTurnProps) {
  const [collapseVersion, requestCollapse] = useReducer((value: number) => value + 1, 0);
  const localDisclosure = useToolActivityDisclosure(sharedDisclosure ? undefined : sessionIdentity);
  const disclosure = sharedDisclosure ?? localDisclosure;
  const { collapse } = disclosure;
  const handleBodyClick = useCallback(() => {
    requestCollapse();
    collapse();
  }, [collapse]);
  const [lightboxImg, setLightboxImg] = useState<(MessageLightboxState & { sessionIdentity?: SessionIdentity }) | null>(null);

  const isStreaming = isActiveReplyStatus(item.status);

  useEffect(() => {
    if (!containsTodoToolDebugSignal(item)) {
      return;
    }
    logRendererTodoToolDebug(
      'renderer.ChatAssistantTurn.render-item',
      () => (summarizeAssistantTurnForTodoToolDebug(item)),
    );
  }, [item]);

  const partRenderers = useContributions(messageParts);
  const textModel = getSessionTextModel(sessionIdentity);
  const messageRenderTextByKey = useMemo(() => buildMessageSegmentRenderTextByKey(item, textModel), [item, textModel]);
  const resolvedToolSlots = useMemo(() => toolSlots ?? buildToolGroupPlan([item]).get(item.key), [item, toolSlots]);
  const coveredOnly = isCoveredToolOnlyItem(item, resolvedToolSlots);
  const toolSessionIdentity = sessionIdentity && !validateSessionIdentity(sessionIdentity)
    && item.sessionKey === sessionIdentity.sessionKey
    && (item.agentId === undefined || item.agentId === sessionIdentity.agentId) ? sessionIdentity : undefined;

  const hasContentSegments = item.segments.some((segment) => {
    if (segment.kind === 'thinking') {
      return showThinking && segment.text.trim().length > 0;
    }
    if (segment.kind === 'message') {
      return !!segment.largeText || (messageRenderTextByKey.get(segment.key) ?? segment.text).trim().length > 0;
    }
    if (segment.kind === 'tool') {
      return resolvedToolSlots?.get(segment.key)?.kind !== 'covered';
    }
    return segment.images.length > 0 || segment.attachedFiles.length > 0 || !!segment.contentNotices?.length;
  });
  const pendingMode = !coveredOnly && !hasContentSegments && isStreaming
    ? (item.pendingState ?? (item.status === 'waiting_tool' ? 'activity' : 'typing'))
    : null;
  const rawPlainText = getAssistantTurnPlainText(item);
  const plainText = textModel.assistant(rawPlainText);
  const mediaPresentation = useMemo(() => {
    const seen = new Set<string>();
    const attachedFiles: AttachedFileMeta[] = [];
    const segments = item.segments.map((segment) => {
      if (segment.kind !== 'media') return segment;
      const files = segment.attachedFiles.filter((file) => {
        const refs = [file.resourceId, file.filePath, file.gatewayUrl, file.mediaReference].filter((ref): ref is string => !!ref);
        const duplicate = refs.some((ref) => seen.has(ref));
        for (const ref of refs) seen.add(ref);
        if (!duplicate) attachedFiles.push(file);
        return !duplicate;
      });
      return { ...segment, attachedFiles: files };
    });
    const attached = createAttachedMediaMatcher(attachedFiles);
    return {
      attachedFiles,
      segments: segments.map((segment) => segment.kind !== 'media' ? segment : {
        ...segment,
        images: segment.images.filter((image) => {
          const source = image.url || (image.data ? `data:${image.mimeType};base64,${image.data}` : '');
          if (!source || attached(source) || seen.has(source)) return false;
          seen.add(source);
          return true;
        }),
      }),
    };
  }, [item.segments]);
  const extractArtifactRefs = useArtifactRefExtractor();
  const messageFileRefs = useMemo(() => extractArtifactRefs(rawPlainText).filter((file) => file.filePath), [extractArtifactRefs, rawPlainText]);
  const markdownAttachedFiles = useMemo(() => [
    ...mediaPresentation.attachedFiles,
    ...mediaPresentation.segments.flatMap((segment) => segment.kind === 'media'
      ? segment.images.flatMap((image) => image.url ? [{ fileName: '', mimeType: image.mimeType, fileSize: 0, preview: null, gatewayUrl: image.url }] : [])
      : []),
    ...messageFileRefs,
  ], [messageFileRefs, mediaPresentation]);
  useEffect(() => {
    if (!isSessionTraceEnabled()) return;
    logSessionTrace('session.assistant-turn.committed', 'session-assistant-turn-boundary', () => ({
      identity: summarizeSessionIdentity(sessionIdentity), item: summarizeRenderItem(item),
      hasContentSegments, pendingMode, rendered: hasContentSegments || !!pendingMode,
      rawPlainText: summarizeText(rawPlainText), cleanedPlainText: summarizeText(plainText),
      segmentCount: item.segments.length, summarizedSegmentCount: Math.min(item.segments.length, 64), truncated: item.segments.length > 64,
      messageSegments: item.segments.slice(0, 64).flatMap((segment, segmentIndex) => {
        if (segment.kind !== 'message') return [];
        const renderText = messageRenderTextByKey.get(segment.key) ?? segment.text;
        return [{ segmentIndex, itemHash: summarizeIdentifier(item.key).hash, segmentHash: summarizeIdentifier(segment.key).hash,
          markdownKeyHash: summarizeIdentifier(`${item.key}:segment:${segment.key}`).hash,
          input: summarizeText(segment.text), assembled: summarizeText(renderText), hasLargeText: !!segment.largeText,
          rendered: !!segment.largeText || !!renderText.trim() }];
      }),
    }));
  }, [hasContentSegments, item, messageRenderTextByKey, pendingMode, plainText, rawPlainText, sessionIdentity]);
  const visible = hasContentSegments || !!pendingMode;

  const renderedSegments = visible ? mediaPresentation.segments.map((segment) => {
    const Part = resolveMessagePartRenderer(segment.kind, partRenderers)?.component;
    return Part ? (
      <Suspense key={segment.key} fallback={null}>
        <Part
          segment={segment}
          itemKey={item.key}
          createdAt={item.createdAt}
          renderText={messageRenderTextByKey.get(segment.key)}
          attachedFiles={markdownAttachedFiles}
          isStreaming={isStreaming}
          showThinking={showThinking}
          collapseVersion={collapseVersion}
          toolSlot={resolvedToolSlots?.get(segment.key)}
          disclosure={disclosure}
          latestBrowserTools={latestBrowserTools}
          sessionIdentity={sessionIdentity}
          toolSessionIdentity={toolSessionIdentity}
          toolIsImmutable={segment.kind === 'tool' && isControlledSessionRenderTool(segment.tool)}
          endpointSessionId={endpointSessionId}
          onBodyClick={handleBodyClick}
          onPreview={(preview) => setLightboxImg({ ...preview, sessionIdentity })}
          onOpenFile={onOpenAttachedArtifact}
          onOpenToolSurface={openToolSurface}
          onRuntimeSendMessage={onRuntimeSendMessage}
          onRuntimeOpenLink={onRuntimeOpenLink}
        />
      </Suspense>
    ) : null;
  }) : null;
  return (
    <>
      <AssistantTurnShell
        item={item}
        replyStartedAt={replyStartedAt}
        assistantAvatarSlot={assistantAvatarSlot}
        userAvatarImageUrl={userAvatarImageUrl}
        plainText={plainText}
        visible={visible}
      >
        {renderedSegments}

        {pendingMode ? <AssistantPendingIndicator mode={pendingMode} /> : null}
      </AssistantTurnShell>
      {visible && lightboxImg && (
        <ChatImageLightbox
          src={lightboxImg.src}
          fileName={lightboxImg.fileName}
          filePath={lightboxImg.filePath}
          mediaReference={lightboxImg.mediaReference}
          mimeType={lightboxImg.mimeType}
          sessionIdentity={lightboxImg.sessionIdentity}
          onClose={() => setLightboxImg(null)}
        />
      )}
    </>
  );
});
