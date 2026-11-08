import { useContributions } from '@/plugin-host/react';
import { isControlledSessionRenderTool } from '@/plugins/chat/store/session-render-projection';
import { messageParts, resolveMessagePartRenderer } from '@/plugins/message-rendering/extensions';
import { Suspense, useCallback, useEffect, useMemo, useState, memo, useReducer, type ReactNode } from 'react';
import { useReplyDuration, type ReplyTiming } from '@/plugins/chat/reply-timing';
import { useTranslation } from 'react-i18next';
import type { ChatAssistantTurnItem } from '@/plugins/message-rendering/chat-render-item-model';
import { buildAssistantTurnView } from '@/plugins/chat/assistant-turn-view';
import { buildToolGroupPlan } from '@/plugins/chat/tool-group-plan';
import type { ToolSlot } from '@/plugins/message-rendering/tool-groups';
import type { ToolActivityDisclosure } from '@/plugins/message-rendering/tool-renderers/types';
import { useToolActivityDisclosure } from '@/plugins/message-rendering/useToolActivityDisclosure';
import type { AttachedFileMeta } from '@/plugins/message-rendering/attachments';
import { MessageShell, type MessageAvatarSlot } from '@/plugins/message-rendering/chat-message-shell';
import { MESSAGE_LAYOUT_TOKENS, getAssistantBlockSpacing } from '@/plugins/message-rendering/message-layout-tokens';
import { ChatImageLightbox } from '@/plugins/message-rendering/ChatImageLightbox';
import { AssistantPendingIndicator } from '@/plugins/chat/components/AssistantPendingIndicator';
import { AssistantWorkSummary } from '@/plugins/chat/components/AssistantWorkSummary';
import type { ThreadWorkPresentation } from '@/plugins/chat/thread-work';
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
import { getSessionTextModel } from '@/plugins/chat/store/session-presentation';
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
  work?: ThreadWorkPresentation;
  workDisclosure?: ToolActivityDisclosure;
  showThinking: boolean;
  timing?: ReplyTiming;
  footer?: string | null;
  view?: ReturnType<typeof buildAssistantTurnView>;
  assistantAvatarSlot?: MessageAvatarSlot;
  userAvatarImageUrl?: string | null;
  sessionIdentity?: SessionIdentity;
  endpointSessionId?: string | null;
  workspaceContext?: WorkspaceFileContext;
  onOpenAttachedArtifact?: (file: AttachedFileMeta) => boolean | void;
  onRuntimeSendMessage?: (text: string) => void | Promise<void>;
  onRuntimeOpenLink?: (url: string) => void | Promise<void>;
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

function AssistantTurnMetaBar({ timing, status, plainText }: {
  timing?: ReplyTiming;
  status: ChatAssistantTurnItem['status'];
  plainText: string;
}) {
  const { t } = useTranslation('chat');
  const duration = useReplyDuration(timing);
  const replyDurationLabel = duration
    ? t(timing?.kind === 'running' ? 'replyTiming.running' : status === 'aborted' ? 'replyTiming.stopped' : status === 'error' ? 'replyTiming.failed' : 'replyTiming.completed', { duration })
    : null;
  return plainText || replyDurationLabel
    ? <AssistantMessageMetaBar text={plainText} statusLabel={replyDurationLabel ?? undefined} />
    : null;
}

function AssistantTurnShell({
  item,
  timing,
  assistantAvatarSlot,
  userAvatarImageUrl,
  plainText,
  visible,
  showMeta,
  pending,
  children,
}: Pick<ChatAssistantTurnProps, 'item' | 'timing' | 'assistantAvatarSlot' | 'userAvatarImageUrl'> & {
  showMeta: boolean;
  pending: boolean;
  plainText: string;
  visible: boolean;
  children?: ReactNode;
}) {
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
      {showMeta ? <AssistantTurnMetaBar timing={pending ? undefined : timing} status={item.status} plainText={plainText} /> : null}
    </MessageShell>
  );
}

export const ChatAssistantTurn = memo(function ChatAssistantTurn({
  item,
  toolSlots,
  latestBrowserTools,
  disclosure: sharedDisclosure,
  work,
  workDisclosure,
  showThinking,
  timing,
  footer,
  view: projectedView,
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
  const workExpanded = !!work && !!workDisclosure?.expandedKeys.has(work.key);
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
  const resolvedToolSlots = useMemo(() => toolSlots ?? buildToolGroupPlan([item]).get(item.key), [item, toolSlots]);
  const view = useMemo(() => projectedView ?? buildAssistantTurnView(item, showThinking, textModel.assistant, resolvedToolSlots),
    [projectedView, item, showThinking, textModel, resolvedToolSlots]);
  const { segments, attachedFiles, messageRenderTextByKey, pendingMode, plainText, visible } = view;
  const hasContentSegments = segments.length > 0;
  const toolSessionIdentity = sessionIdentity && !validateSessionIdentity(sessionIdentity)
    && item.sessionKey === sessionIdentity.sessionKey
    && (item.agentId === undefined || item.agentId === sessionIdentity.agentId) ? sessionIdentity : undefined;

  const rawPlainText = getAssistantTurnPlainText(item);
  const extractArtifactRefs = useArtifactRefExtractor();
  const messageFileRefs = useMemo(() => extractArtifactRefs(rawPlainText).filter((file) => file.filePath), [extractArtifactRefs, rawPlainText]);
  const markdownAttachedFiles = useMemo(() => [
    ...attachedFiles,
    ...segments.flatMap((segment) => segment.kind === 'media'
      ? segment.images.flatMap((image) => image.url ? [{ fileName: '', mimeType: image.mimeType, fileSize: 0, preview: null, gatewayUrl: image.url }] : [])
      : []),
    ...messageFileRefs,
  ], [messageFileRefs, attachedFiles, segments]);
  useEffect(() => {
    if (!isSessionTraceEnabled()) return;
    const thinkingSegments = segments.filter((segment) => segment.kind === 'thinking');
    const hasThinkingRenderer = !!resolveMessagePartRenderer('thinking', partRenderers);
    logSessionTrace('session.assistant-turn.committed', 'session-assistant-turn-boundary', () => ({
      identity: summarizeSessionIdentity(sessionIdentity), item: summarizeRenderItem(item),
      hasContentSegments, pendingMode, rendered: hasContentSegments || !!pendingMode, visible, showThinking,
      thinkingSegmentCount: thinkingSegments.length, thinkingSegmentsTruncated: thinkingSegments.length > 64,
      thinkingSegments: thinkingSegments.slice(0, 64).map((segment) => ({
        segmentHash: summarizeIdentifier(segment.key).hash,
        renderEligible: visible && showThinking && !!segment.text.trim() && hasThinkingRenderer,
      })),
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
  }, [hasContentSegments, item, messageRenderTextByKey, partRenderers, pendingMode, plainText, rawPlainText, segments, sessionIdentity, showThinking, visible]);

  const renderedSegments = visible ? segments.map((segment, index) => {
    const Part = resolveMessagePartRenderer(segment.kind, partRenderers)?.component;
    const isWorkSegment = !!work?.segmentKeys.has(segment.key);
    const isWorkHead = isWorkSegment && work?.headSegmentKey === segment.key;
    return Part ? (
      <div key={segment.key} data-chat-work-key={isWorkSegment ? work?.key : undefined} className={index > 0 && (!isWorkSegment || workExpanded || isWorkHead) ? getAssistantBlockSpacing(segments[index - 1].kind, segment.kind) : undefined}>
        {isWorkHead && work && workDisclosure ? (
          <AssistantWorkSummary work={work} expanded={workExpanded} onToggle={() => workDisclosure.toggle(work.key)} />
        ) : null}
        <div
          hidden={isWorkSegment && !workExpanded}
          data-chat-work-key={isWorkSegment ? work?.key : undefined}
          className={isWorkHead ? 'pt-2' : undefined}
        >
          <Suspense fallback={null}>
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
        </div>
      </div>
    ) : null;
  }) : null;
  return (
    <>
      <AssistantTurnShell
        item={item}
        timing={timing}
        assistantAvatarSlot={assistantAvatarSlot}
        userAvatarImageUrl={userAvatarImageUrl}
        plainText={footer ?? plainText}
        visible={visible}
        showMeta={footer !== null}
        pending={!!pendingMode}
      >
        <div className={MESSAGE_LAYOUT_TOKENS.assistantSegments}>
          {renderedSegments}
          {pendingMode ? <AssistantPendingIndicator mode={pendingMode} timing={timing} /> : null}
        </div>
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
