import { useCallback, useEffect, useMemo, useState, memo, useReducer } from 'react';
import type { ChatAssistantTurnItem } from './chat-render-item-model';
import type { AttachedFileMeta } from '@/stores/chat';
import { AssistantMessageBody } from './assistant-message-body';
import { MessageShell } from './chat-message-shell';
import { ChatImageLightbox } from './components/ChatImageLightbox';
import { AssistantPendingIndicator } from './components/AssistantPendingIndicator';
import { getAssistantTurnPlainText } from './chat-message-view';
import {
  AssistantMessageMedia,
  AssistantEmbeddedToolResults,
  AssistantMessageMetaBar,
  ThinkingSection,
  ToolCardList,
  type MessageLightboxState,
} from './chat-message-parts';
import type { SessionRenderAssistantBubbleToolResult, SessionRenderToolCard } from '../../types/session/tool-card';
import { isOpenClawTool, readBrowserTabPreview, readMcpAppPreview } from './tool-renderers/openclaw-details';
import { openChatRuntimeSurface, type ChatRuntimeSurfaceDescriptor } from './useChatSidePanelController';
import { extractArtifactRefsFromAssistantText } from './artifact-paths';
import { sanitizeAssistantDisplayText } from '@/stores/chat/message-display';
import { hostFileStat, hostWorkspaceMediaThumbnail, type WorkspaceFileContext } from '@/lib/host-api';
import { DIRECTORY_MIME_TYPE, resolveWorkspaceRelativePath } from '@/components/file-preview/types';
import type {
  SessionIdentity,
} from '../../../electron/desktop-contract/runtime-address';
import {
  containsTodoToolDebugSignal,
  logRendererTodoToolDebug,
  summarizeAssistantTurnForTodoToolDebug,
} from '@/stores/chat/todo-tool-debug';

interface ChatAssistantTurnProps {
  item: ChatAssistantTurnItem;
  showThinking: boolean;
  replyStartedAt?: number;
  userAvatarImageUrl?: string | null;
  sessionIdentity?: SessionIdentity;
  endpointSessionId?: string | null;
  workspaceContext?: WorkspaceFileContext;
  onOpenAttachedArtifact?: (file: AttachedFileMeta) => void;
}

type MarkdownFenceState = {
  marker: '`' | '~';
  length: number;
} | null;

type DerivedGatewayPreview = {
  preview: string | null;
  fileSize: number;
  previewStatus?: 'unavailable';
};

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

function buildMessageSegmentRenderTextByKey(item: ChatAssistantTurnItem): Map<string, string> {
  const renderTextByKey = new Map<string, string>();
  let fenceState: MarkdownFenceState = null;
  for (const segment of item.segments) {
    if (segment.kind !== 'message') {
      continue;
    }
    const renderText = sanitizeAssistantDisplayText(removeLeadingFenceClose(segment.text, fenceState));
    renderTextByKey.set(segment.key, renderText);
    fenceState = advanceMarkdownFenceState(segment.text, fenceState);
  }
  return renderTextByKey;
}

function toAssistantBubbleToolResult(segment: ChatAssistantTurnItem['segments'][number]): SessionRenderAssistantBubbleToolResult | null {
  if (segment.kind !== 'tool'
    || segment.tool.result.kind !== 'canvas'
    || segment.tool.result.surface !== 'assistant-bubble'
    || segment.tool.result.preview.surface !== 'assistant_message') {
    return null;
  }
  return {
    key: segment.tool.toolCallId || segment.tool.id || segment.key,
    ...(segment.tool.toolCallId ? { toolCallId: segment.tool.toolCallId } : {}),
    toolName: segment.tool.name,
    preview: segment.tool.result.preview,
    ...(segment.tool.result.rawText ? { rawText: segment.tool.result.rawText } : {}),
  };
}

function hasBrowserTabPreview(tool: SessionRenderToolCard): boolean {
  return isOpenClawTool(tool) && readBrowserTabPreview(tool.details) != null;
}

function buildRuntimeSurfaceDescriptor(tool: SessionRenderToolCard): ChatRuntimeSurfaceDescriptor | null {
  if (!isOpenClawTool(tool)) {
    return null;
  }
  const browserTab = readBrowserTabPreview(tool.details);
  if (browserTab) {
    return {
      ...browserTab,
      toolName: tool.name,
      ...(tool.toolCallId ? { toolCallId: tool.toolCallId } : {}),
    };
  }
  const mcpAppPreview = readMcpAppPreview(tool.details);
  if (!mcpAppPreview) {
    return null;
  }
  return {
    kind: 'mcp-app',
    toolName: tool.name,
    ...(mcpAppPreview.surface ? { surface: mcpAppPreview.surface } : {}),
    ...(mcpAppPreview.title ? { title: mcpAppPreview.title } : {}),
    ...(mcpAppPreview.url ? { url: mcpAppPreview.url } : {}),
    ...(mcpAppPreview.viewId ? { viewId: mcpAppPreview.viewId } : {}),
    ...(mcpAppPreview.preferredHeight !== undefined ? { preferredHeight: mcpAppPreview.preferredHeight } : {}),
    ...(mcpAppPreview.sandbox ? { sandbox: mcpAppPreview.sandbox } : {}),
    ...(mcpAppPreview.boardWidgetName ? { boardWidgetName: mcpAppPreview.boardWidgetName } : {}),
    ...(tool.toolCallId ? { toolCallId: tool.toolCallId } : {}),
    ...(mcpAppPreview.mcpApp ? { mcpApp: mcpAppPreview.mcpApp } : {}),
  };
}

type AssistantTurnRenderPart =
  | { kind: 'segment'; segment: ChatAssistantTurnItem['segments'][number] }
  | { kind: 'tool-group'; key: string; tools: SessionRenderToolCard[] };

function buildAssistantTurnRenderParts(item: ChatAssistantTurnItem): AssistantTurnRenderPart[] {
  const parts: AssistantTurnRenderPart[] = [];
  for (let index = 0; index < item.segments.length; index += 1) {
    const segment = item.segments[index];
    if (segment.kind !== 'tool' || toAssistantBubbleToolResult(segment) || !hasBrowserTabPreview(segment.tool)) {
      parts.push({ kind: 'segment', segment });
      continue;
    }

    const tools: SessionRenderToolCard[] = [segment.tool];
    let endIndex = index;
    while (endIndex + 1 < item.segments.length) {
      const nextSegment = item.segments[endIndex + 1];
      if (nextSegment.kind !== 'tool' || toAssistantBubbleToolResult(nextSegment) || !hasBrowserTabPreview(nextSegment.tool)) {
        break;
      }
      tools.push(nextSegment.tool);
      endIndex += 1;
    }

    parts.push({ kind: 'tool-group', key: segment.key, tools });
    index = endIndex;
  }
  return parts;
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

export const ChatAssistantTurn = memo(function ChatAssistantTurn({
  item,
  showThinking,
  replyStartedAt,
  userAvatarImageUrl,
  sessionIdentity,
  endpointSessionId,
  workspaceContext,
  onOpenAttachedArtifact,
}: ChatAssistantTurnProps) {
  const [collapseVersion, requestCollapse] = useReducer((value: number) => value + 1, 0);
  const [lightboxImg, setLightboxImg] = useState<MessageLightboxState | null>(null);
  const [validatedDerivedPaths, setValidatedDerivedPaths] = useState<Record<string, boolean>>({});
  const [derivedGatewayPreviews, setDerivedGatewayPreviews] = useState<Record<string, DerivedGatewayPreview>>({});
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

  useEffect(() => {
    if (!containsTodoToolDebugSignal(item)) {
      return;
    }
    logRendererTodoToolDebug(
      'renderer.ChatAssistantTurn.render-item',
      summarizeAssistantTurnForTodoToolDebug(item),
    );
  }, [item]);

  const messageRenderTextByKey = useMemo(() => buildMessageSegmentRenderTextByKey(item), [item]);
  const renderParts = useMemo(() => buildAssistantTurnRenderParts(item), [item]);

  const hasContentSegments = item.segments.some((segment) => {
    if (segment.kind === 'thinking') {
      return showThinking && segment.text.trim().length > 0;
    }
    if (segment.kind === 'message') {
      return !!segment.largeText || (messageRenderTextByKey.get(segment.key) ?? segment.text).trim().length > 0;
    }
    if (segment.kind === 'tool') {
      return true;
    }
    return segment.images.length > 0 || segment.attachedFiles.length > 0;
  });
  const pendingMode = !hasContentSegments && isStreaming
    ? (item.pendingState ?? (item.status === 'waiting_tool' ? 'activity' : 'typing'))
    : null;
  const rawPlainText = getAssistantTurnPlainText(item);
  const plainText = sanitizeAssistantDisplayText(rawPlainText);
  const attachedByRef = useMemo(() => {
    const next = new Set<string>();
    for (const segment of item.segments) {
      if (segment.kind !== 'media') {
        continue;
      }
      for (const file of segment.attachedFiles as AttachedFileMeta[]) {
        const ref = file.filePath || file.gatewayUrl;
        if (ref) {
          next.add(ref);
        }
      }
    }
    return next;
  }, [item.segments]);
  const derivedAttachedFiles = useMemo(() => (
    extractArtifactRefsFromAssistantText(rawPlainText).filter((file) => {
      const ref = file.filePath || file.gatewayUrl;
      return !ref || !attachedByRef.has(ref);
    })
  ), [attachedByRef, rawPlainText]);

  useEffect(() => {
    if (!sessionIdentity) {
      return;
    }
    if (derivedAttachedFiles.length === 0) {
      return;
    }
    const pendingPaths = derivedAttachedFiles
      .map((file) => file.filePath)
      .filter((filePath): filePath is string => !!filePath && validatedDerivedPaths[filePath] === undefined);
    if (pendingPaths.length === 0) {
      return;
    }

    let cancelled = false;
    void Promise.all(pendingPaths.map(async (filePath) => {
      try {
        const relativePath = resolveWorkspaceRelativePath(filePath, workspaceContext?.workspaceRoot);
        if (!relativePath) {
          return { filePath, ok: false };
        }
        const stat = await hostFileStat({
          endpoint: sessionIdentity.endpoint,
          sessionKey: sessionIdentity.sessionKey,
          relativePath,
          ...workspaceContext,
        });
        const expectDir = derivedAttachedFiles.find((file) => file.filePath === filePath)?.mimeType === DIRECTORY_MIME_TYPE;
        return {
          filePath,
          ok: !!stat.ok && (expectDir ? !!stat.isDirectory : !stat.isDirectory),
        };
      } catch {
        return { filePath, ok: false };
      }
    })).then((results) => {
      if (cancelled) {
        return;
      }
      setValidatedDerivedPaths((current) => {
        const next = { ...current };
        for (const result of results) {
          next[result.filePath] = result.ok;
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [derivedAttachedFiles, sessionIdentity, validatedDerivedPaths, workspaceContext]);

  useEffect(() => {
    if (!sessionIdentity) {
      return;
    }
    const pendingGatewayFiles = derivedAttachedFiles.filter((file) => (
      file.gatewayUrl && derivedGatewayPreviews[file.gatewayUrl] === undefined
    ));
    if (pendingGatewayFiles.length === 0) {
      return;
    }

    let cancelled = false;
    void Promise.all(pendingGatewayFiles.map(async (file) => {
      const gatewayUrl = file.gatewayUrl!;
      try {
        const thumbnail = await hostWorkspaceMediaThumbnail({
          gatewayUrl,
          mimeType: file.mimeType,
          agentId: sessionIdentity.agentId,
          sessionIdentity,
        });
        return {
          gatewayUrl,
          preview: thumbnail.preview ?? null,
          fileSize: thumbnail.fileSize || file.fileSize,
          ...(thumbnail.preview ? {} : { previewStatus: 'unavailable' as const }),
        };
      } catch {
        return {
          gatewayUrl,
          preview: null,
          fileSize: file.fileSize,
          previewStatus: 'unavailable' as const,
        };
      }
    })).then((results) => {
      if (cancelled) {
        return;
      }
      setDerivedGatewayPreviews((current) => {
        const next = { ...current };
        for (const result of results) {
          next[result.gatewayUrl] = {
            preview: result.preview,
            fileSize: result.fileSize,
            ...(result.previewStatus ? { previewStatus: result.previewStatus } : {}),
          };
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [derivedAttachedFiles, derivedGatewayPreviews, sessionIdentity]);

  const visibleDerivedAttachedFiles = useMemo(() => (
    derivedAttachedFiles
      .filter((file) => !file.filePath || validatedDerivedPaths[file.filePath] === true)
      .map((file) => {
        if (!file.gatewayUrl) {
          return file;
        }
        const preview = derivedGatewayPreviews[file.gatewayUrl];
        if (!preview) {
          return file;
        }
        return {
          ...file,
          preview: preview.preview,
          fileSize: preview.fileSize,
          ...(preview.previewStatus ? { previewStatus: preview.previewStatus } : {}),
        };
      })
  ), [derivedAttachedFiles, derivedGatewayPreviews, validatedDerivedPaths]);
  const renderToolCards = useCallback((tools: SessionRenderToolCard[], collapseKey: string) => {
    const descriptors = tools
      .map(buildRuntimeSurfaceDescriptor)
      .filter((descriptor): descriptor is ChatRuntimeSurfaceDescriptor => descriptor != null);
    if (descriptors.length === 0) {
      return <ToolCardList tools={tools} collapseVersion={collapseVersion} />;
    }
    return (
      <div
        data-testid={`chat-runtime-surface-open-${collapseKey}`}
        className="w-full cursor-pointer"
        onClick={() => openChatRuntimeSurface(descriptors[descriptors.length - 1]!)}
      >
        <ToolCardList tools={tools} collapseVersion={collapseVersion} />
      </div>
    );
  }, [collapseVersion]);
  if (!hasContentSegments && visibleDerivedAttachedFiles.length === 0 && !pendingMode) {
    return null;
  }

  return (
    <>
      <MessageShell
        isUser={false}
        assistantAgentId={item.assistantPresentation?.agentId}
        assistantAgentName={item.assistantPresentation?.agentName}
        assistantAvatarSeed={item.assistantPresentation?.avatarSeed}
        assistantAvatarStyle={item.assistantPresentation?.avatarStyle}
        userAvatarImageUrl={userAvatarImageUrl}
      >
        {renderParts.map((part) => {
          if (part.kind === 'tool-group') {
            return (
              <div key={part.key} className="flex w-full flex-col items-start gap-0 pt-0">
                {renderToolCards(part.tools, part.key)}
              </div>
            );
          }
          const { segment } = part;
          if (segment.kind === 'thinking') {
            if (!showThinking || !segment.text.trim()) {
              return null;
            }
            return (
              <div key={segment.key} className="flex w-full flex-col items-start gap-0.5 pt-0.5">
                <ThinkingSection content={segment.text} collapseVersion={collapseVersion} />
              </div>
            );
          }
          if (segment.kind === 'tool') {
            const embeddedToolResult = toAssistantBubbleToolResult(segment);
            if (embeddedToolResult) {
              return (
                <div key={segment.key} className="flex w-full flex-col items-start gap-0 pt-0">
                  <AssistantEmbeddedToolResults
                    embeddedToolResults={[embeddedToolResult]}
                    collapseVersion={collapseVersion}
                  />
                </div>
              );
            }
            return (
              <div key={segment.key} className="flex w-full flex-col items-start gap-0 pt-0">
                {renderToolCards([segment.tool], segment.key)}
              </div>
            );
          }
          if (segment.kind === 'message') {
            const renderText = messageRenderTextByKey.get(segment.key) ?? segment.text;
            if (!segment.largeText && !renderText.trim()) {
              return null;
            }
            return (
              <AssistantMessageBody
                key={segment.key}
                itemKey={`${item.key}:segment:${segment.key}`}
                createdAt={item.createdAt}
                text={renderText}
                isStreaming={isStreaming}
                largeText={segment.largeText}
                sessionIdentity={sessionIdentity}
                endpointSessionId={endpointSessionId}
                onBodyClick={requestCollapse}
              />
            );
          }
          return (
            <AssistantMessageMedia
              key={segment.key}
              images={segment.images}
              attachedFiles={segment.attachedFiles}
              onPreview={setLightboxImg}
              onOpenFile={onOpenAttachedArtifact}
            />
          );
        })}

        {visibleDerivedAttachedFiles.length > 0 ? (
          <AssistantMessageMedia
            images={[]}
            attachedFiles={visibleDerivedAttachedFiles}
            onPreview={setLightboxImg}
            onOpenFile={onOpenAttachedArtifact}
          />
        ) : null}

        {pendingMode ? <AssistantPendingIndicator mode={pendingMode} /> : null}

        {(plainText || replyDurationLabel) ? (
          <AssistantMessageMetaBar text={plainText} timestamp={item.createdAt} statusLabel={replyDurationLabel} />
        ) : null}
      </MessageShell>

      {lightboxImg && (
        <ChatImageLightbox
          src={lightboxImg.src}
          fileName={lightboxImg.fileName}
          filePath={lightboxImg.filePath}
          onClose={() => setLightboxImg(null)}
        />
      )}
    </>
  );
});
