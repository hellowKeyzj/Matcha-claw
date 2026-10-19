import { isTraceEnabled } from '@/lib/trace-logger';
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEventHandler,
  type RefObject,
  type TouchEventHandler,
  type WheelEventHandler,
} from 'react';
import { ArrowDown } from 'lucide-react';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getSessionTextModel, type SessionTextModel } from '@/stores/chat/session-presentation';
import { CHAT_LAYOUT_TOKENS } from '../chat-layout-tokens';
import { createChatScrollChromeStore, type ChatScrollChromeStore } from '../chat-scroll-chrome-store';
import type {
  ChatAssistantPresentation,
  ChatAssistantTurnItem,
  ChatExecutionGraphItem,
  ChatRenderItem,
  ChatUserMessageItem,
} from '../chat-render-item-model';
import { ChatMessage } from '../ChatMessage';
import { ChatAssistantTurn } from '../ChatAssistantTurn';
import { useToolActivityDisclosure } from '../useToolActivityDisclosure';
import { buildToolGroupPlan, isCoveredToolOnlyItem, selectLatestBrowserTools, type ToolGroupPlan, type ToolSlot } from '../chat-tool-groups';
import type { SessionRenderToolCard } from '../../../types/session/tool-card';
import type { ToolActivityDisclosure } from '../tool-renderers/types';
import { MessageShell, type MessageAvatarSlot } from '../chat-message-shell';
import { ExecutionGraphCard } from '../ExecutionGraphCard';
import { useChatScroll } from '../useChatScroll';
import { sampleViewportAnchor, type ViewportAnchor } from '../chat-scroll-model';
import type { UseChatViewResult } from '../useChatView';
import { FailureScreen } from './ChatStates';
import { AssistantPendingIndicator } from './AssistantPendingIndicator';
import type { ChatSessionPending } from '@/stores/chat/types';
import type { ChatArtifactGroup } from '../artifacts';
import type {
  AttachedFileMeta,
  ChatSessionRuntimeState,
  ChatSessionViewportState,
} from '@/stores/chat';
import type {
  SessionIdentity,
} from '../../../types/desktop/runtime-address';
import type { WorkspaceFileContext } from '@/lib/host-api';
import type { GeneratedFile } from '@/lib/generated-files';
import { isSessionTraceEnabled, logSessionTrace, summarizeIdentifier, summarizeRenderItems, summarizeSessionIdentity } from '@/lib/session-trace';

const STARTUP_TRACE_PREFIX = '[startup-trace]';
const tracedFirstPaintSessionKeys = new Set<string>();

export interface ChatListHandle {
  prepareCurrentLatestBottomAlign: () => void;
  scrollByWheelDelta: (deltaY: number) => void;
  notifyComposerGeometryChanged: () => void;
}

export interface ChatListProps {
  isActive: boolean;
  currentSessionKey: string;
  runtime: ChatSessionRuntimeState;
  viewport: ChatSessionViewportState;
  items: ChatRenderItem[];
  activity?: Extract<ChatSessionPending, { kind: 'activity' }>['mode'] | null;
  assistantPresentation?: ChatAssistantPresentation;
  liveView: UseChatViewResult;
  errorMessage: string | null;
  showThinking: boolean;
  userAvatarDataUrl: string | null;
  sessionIdentity?: SessionIdentity;
  endpointSessionId?: string | null;
  workspaceContext?: WorkspaceFileContext;
  onLoadOlder: () => void;
  loadOlderLabel: string;
  onJumpToLatest: () => void;
  jumpToBottomLabel: string;
  artifactGroups: ChatArtifactGroup[];
  onOpenArtifactFile: (file: GeneratedFile) => void;
  onOpenAttachedArtifact: (file: AttachedFileMeta) => void;
  onReuseMessage?: (text: string) => void;
  onRuntimeSendMessage?: (text: string) => void | Promise<void>;
  onRuntimeOpenLink?: (url: string) => void | Promise<void>;
}

interface ChatListSurfaceProps {
  messagesViewportRef: RefObject<HTMLDivElement | null>;
  messageContentRef: RefObject<HTMLDivElement | null>;
  isEmptyState: boolean;
  showBlockingLoading: boolean;
  showBlockingError: boolean;
  errorMessage: string | null;
  onPointerDown: () => void;
  onScroll: () => void;
  onTouchMove: TouchEventHandler<HTMLDivElement>;
  onWheel: WheelEventHandler<HTMLDivElement>;
  onViewportClickCapture: MouseEventHandler<HTMLDivElement>;
  items: ChatRenderItem[];
  activity?: Extract<ChatSessionPending, { kind: 'activity' }>['mode'] | null;
  assistantPresentation?: ChatAssistantPresentation;
  showLoadOlder: boolean;
  isLoadingOlder: boolean;
  onLoadOlder: () => void;
  loadOlderLabel: string;
  scrollChromeStore: ChatScrollChromeStore;
  showThinking: boolean;
  userAvatarImageUrl: string | null;
  sessionIdentity?: SessionIdentity;
  endpointSessionId?: string | null;
  workspaceContext?: WorkspaceFileContext;
  onJumpToItemKey: (itemKey?: string) => void;
  artifactFilesByGraphKey: ReadonlyMap<string, GeneratedFile[]>;
  onOpenArtifactFile: (file: GeneratedFile) => void;
  onOpenAttachedArtifact: (file: AttachedFileMeta) => void;
  onReuseMessage?: (text: string) => void;
  onRuntimeSendMessage?: (text: string) => void | Promise<void>;
  onRuntimeOpenLink?: (url: string) => void | Promise<void>;
}

type ChatListContentProps = Omit<
  ChatListSurfaceProps,
  'messagesViewportRef' | 'messageContentRef' | 'onPointerDown' | 'onScroll' | 'onTouchMove' | 'onWheel' | 'onViewportClickCapture' | 'scrollChromeStore'
>;

function getMessageDataAttributes(item: ChatRenderItem) {
  return {
    'data-chat-item-key': item.key,
    'data-chat-item-kind': item.kind,
    'data-chat-message-timestamp': typeof item.createdAt === 'number' ? String(item.createdAt) : undefined,
    'data-chat-assistant-turn-key': item.kind === 'assistant-turn' ? (item.turnKey ?? undefined) : undefined,
    'data-chat-assistant-lane-key': item.kind === 'assistant-turn' ? (item.laneKey ?? undefined) : undefined,
    'data-chat-assistant-agent-id': item.kind === 'assistant-turn' ? (item.agentId ?? undefined) : undefined,
  };
}

function replyTimerKey(runId?: string, laneKey?: string): string | null {
  if (!runId) {
    return null;
  }
  return `${runId}::${laneKey || 'main'}`;
}

function buildReplyStartedAtByAssistantKey(items: ReadonlyArray<ChatRenderItem>): Map<string, number> {
  const startedAtByTimerKey = new Map<string, number>();
  const startedAtByAssistantKey = new Map<string, number>();
  let latestUserMessageCreatedAt: number | undefined;

  for (const item of items) {
    if (item.kind === 'user-message') {
      if (typeof item.createdAt !== 'number') {
        continue;
      }
      latestUserMessageCreatedAt = item.createdAt;
      const key = replyTimerKey(item.runId, item.laneKey);
      if (key) {
        startedAtByTimerKey.set(key, item.createdAt);
      }
      continue;
    }

    if (item.kind !== 'assistant-turn') {
      continue;
    }

    const timerKey = replyTimerKey(item.runId, item.laneKey);
    const exactStartedAt = timerKey ? startedAtByTimerKey.get(timerKey) : undefined;
    if (typeof exactStartedAt === 'number') {
      startedAtByAssistantKey.set(item.key, exactStartedAt);
      continue;
    }

    if (typeof latestUserMessageCreatedAt === 'number') {
      startedAtByAssistantKey.set(item.key, latestUserMessageCreatedAt);
    }
  }

  return startedAtByAssistantKey;
}

type ChatItemVisualRole = 'assistant-output' | 'boundary' | 'neutral';

function hasVisibleUserOutput(item: ChatUserMessageItem): boolean {
  return !!item.largeText
    || item.text.trim().length > 0
    || item.images.length > 0
    || item.attachedFiles.length > 0;
}

function hasAssistantMessageText(item: ChatAssistantTurnItem, textModel: SessionTextModel): boolean {
  return item.segments.some((segment) => segment.kind === 'message' && (
    !!segment.largeText || textModel.assistant(segment.text).trim().length > 0
  ));
}

function hasVisibleAssistantOutput(
  item: ChatAssistantTurnItem,
  showThinking: boolean,
  textModel: SessionTextModel,
  toolSlots?: ReadonlyMap<string, ToolSlot>,
): boolean {
  if (isCoveredToolOnlyItem(item, toolSlots)) return false;
  return hasAssistantMessageText(item, textModel)
    || item.segments.some((segment) => {
      if (segment.kind === 'thinking') {
        return showThinking && segment.text.trim().length > 0;
      }
      if (segment.kind === 'tool') {
        return toolSlots?.get(segment.key)?.kind !== 'covered';
      }
      if (segment.kind === 'media') {
        return segment.images.length > 0 || segment.attachedFiles.length > 0;
      }
      return false;
    })
    || item.images.length > 0
    || item.attachedFiles.length > 0
    || item.status === 'streaming'
    || item.status === 'waiting_tool';
}

function readVisualRole(item: ChatRenderItem, showThinking: boolean, textModel: SessionTextModel, toolPlan: ToolGroupPlan): ChatItemVisualRole {
  if (item.kind === 'assistant-turn') {
    return hasVisibleAssistantOutput(item, showThinking, textModel, toolPlan.get(item.key)) ? 'assistant-output' : 'neutral';
  }
  if (item.kind === 'user-message') {
    return hasVisibleUserOutput(item) ? 'boundary' : 'neutral';
  }
  if (item.kind === 'system') {
    return item.text.trim() ? 'boundary' : 'neutral';
  }
  return 'neutral';
}

function buildAssistantAvatarSlots(
  items: ReadonlyArray<ChatRenderItem>,
  showThinking: boolean,
  textModel: SessionTextModel,
  toolPlan: ToolGroupPlan,
): Map<string, MessageAvatarSlot> {
  const slots = new Map<string, MessageAvatarSlot>();
  let inAssistantVisualGroup = false;

  for (const item of items) {
    const visualRole = readVisualRole(item, showThinking, textModel, toolPlan);
    if (visualRole === 'assistant-output') {
      slots.set(item.key, inAssistantVisualGroup ? 'placeholder' : 'visible');
      inAssistantVisualGroup = true;
      continue;
    }
    if (visualRole === 'boundary') {
      inAssistantVisualGroup = false;
    }
  }

  return slots;
}

function SystemInfoRow({ item }: { item: ChatRenderItem }) {
  const text = item.text.trim();
  if (!text) {
    return null;
  }
  return (
    <div className="flex justify-center">
      <div className="max-w-[42rem] rounded-[16px] border border-border/40 bg-card px-3 py-2 text-[12px] text-muted-foreground shadow-sm">
        {text}
      </div>
    </div>
  );
}

function renderChatItem(input: {
  item: ChatRenderItem;
  toolSlots?: ReadonlyMap<string, ToolSlot>;
  latestBrowserTools: ReadonlySet<SessionRenderToolCard>;
  disclosure: ToolActivityDisclosure;
  assistantAvatarSlot?: MessageAvatarSlot;
  replyStartedAtByAssistantKey: ReadonlyMap<string, number>;
  showThinking: boolean;
  userAvatarImageUrl: string | null;
  sessionIdentity?: SessionIdentity;
  endpointSessionId?: string | null;
  workspaceContext?: WorkspaceFileContext;
  onJumpToItemKey: (itemKey?: string) => void;
  artifactFilesByGraphKey: ReadonlyMap<string, GeneratedFile[]>;
  onOpenArtifactFile: (file: GeneratedFile) => void;
  onOpenAttachedArtifact: (file: AttachedFileMeta) => void;
  onReuseMessage?: (text: string) => void;
  onRuntimeSendMessage?: (text: string) => void | Promise<void>;
  onRuntimeOpenLink?: (url: string) => void | Promise<void>;
}) {
  if (input.item.kind === 'assistant-turn') {
    return (
      <ChatAssistantTurn
        item={input.item}
        toolSlots={input.toolSlots}
        latestBrowserTools={input.latestBrowserTools}
        disclosure={input.disclosure}
        showThinking={input.showThinking}
        replyStartedAt={input.replyStartedAtByAssistantKey.get(input.item.key)}
        assistantAvatarSlot={input.assistantAvatarSlot}
        userAvatarImageUrl={input.userAvatarImageUrl}
        sessionIdentity={input.sessionIdentity}
        endpointSessionId={input.endpointSessionId}
        workspaceContext={input.workspaceContext}
        onOpenAttachedArtifact={input.onOpenAttachedArtifact}
        onRuntimeSendMessage={input.onRuntimeSendMessage}
        onRuntimeOpenLink={input.onRuntimeOpenLink}
      />
    );
  }
  if (input.item.kind === 'execution-graph') {
    const item = input.item as ChatExecutionGraphItem;
    return (
      <div
        data-testid="chat-execution-graph-rail"
        className={cn(
          CHAT_LAYOUT_TOKENS.messageShell,
          CHAT_LAYOUT_TOKENS.messageShellAssistantColumns,
        )}
      >
        <div
          aria-hidden="true"
          className={cn(
            CHAT_LAYOUT_TOKENS.messageAvatar,
            CHAT_LAYOUT_TOKENS.messageAvatarAssistantOrder,
            'pointer-events-none opacity-0',
          )}
        />
        <div
          className={cn(
            CHAT_LAYOUT_TOKENS.messageContentColumn,
            CHAT_LAYOUT_TOKENS.messageContentAssistantOrder,
          )}
        >
          <ExecutionGraphCard
            agentLabel={item.agentLabel}
            sessionLabel={item.sessionLabel}
            steps={[...item.steps]}
            active={item.active}
            triggerItemKey={item.triggerItemKey}
            replyItemKey={item.replyItemKey}
            onJumpToItemKey={input.onJumpToItemKey}
            artifactFiles={input.artifactFilesByGraphKey.get(item.key) ?? []}
            onOpenArtifactFile={input.onOpenArtifactFile}
          />
        </div>
      </div>
    );
  }
  if (input.item.kind === 'system') {
    return <SystemInfoRow item={input.item} />;
  }
  return (
    <ChatMessage
      item={input.item as ChatUserMessageItem}
      onReuseMessage={input.onReuseMessage}
      userAvatarImageUrl={input.userAvatarImageUrl}
      sessionIdentity={input.sessionIdentity}
      endpointSessionId={input.endpointSessionId}
    />
  );
}

const ChatListContent = memo(function ChatListContent({
  isEmptyState,
  showBlockingLoading,
  showBlockingError,
  errorMessage,
  items,
  activity,
  assistantPresentation,
  showLoadOlder,
  isLoadingOlder,
  onLoadOlder,
  loadOlderLabel,
  showThinking,
  userAvatarImageUrl,
  sessionIdentity,
  endpointSessionId,
  workspaceContext,
  onJumpToItemKey,
  artifactFilesByGraphKey = new Map<string, GeneratedFile[]>(),
  onOpenArtifactFile = () => {},
  onOpenAttachedArtifact = () => {},
  onReuseMessage,
  onRuntimeSendMessage,
  onRuntimeOpenLink,
}: ChatListContentProps) {
  const showLoadOlderButton = showLoadOlder || isLoadingOlder;
  const tracing = isSessionTraceEnabled();
  const metadataStartedAt = tracing ? performance.now() : 0;
  const textModel = getSessionTextModel(sessionIdentity);
  const disclosure = useToolActivityDisclosure(sessionIdentity);
  const [toolPlanState, setToolPlanState] = useState(() => ({ items, plan: buildToolGroupPlan(items) }));
  let toolPlan = toolPlanState.plan;
  if (toolPlanState.items !== items) {
    toolPlan = buildToolGroupPlan(items, toolPlanState.plan);
    setToolPlanState({ items, plan: toolPlan });
  }
  const latestBrowserTools = useMemo(() => selectLatestBrowserTools(items, sessionIdentity), [items, sessionIdentity]);
  const replyStartedAtByAssistantKey = useMemo(() => buildReplyStartedAtByAssistantKey(items), [items]);
  const assistantAvatarSlots = useMemo(() => buildAssistantAvatarSlots(items, showThinking, textModel, toolPlan), [items, showThinking, textModel, toolPlan]);
  const metadataBuildElapsedMs = tracing ? performance.now() - metadataStartedAt : null;
  let contentElementsBuildElapsedMs: number | null = null;
  useEffect(() => {
    if (!isSessionTraceEnabled()) return;
    logSessionTrace('session.chat-list.committed', 'session-chat-list-boundary', () => ({
      identity: summarizeSessionIdentity(sessionIdentity), showThinking,
      metadataBuildElapsedMs, contentElementsBuildElapsedMs,
      rendered: !showBlockingLoading && !showBlockingError && !isEmptyState,
      reason: showBlockingLoading ? 'blocking-loading' : showBlockingError ? 'blocking-error' : isEmptyState ? 'empty-state' : null,
      items: summarizeRenderItems(items),
      routes: items.slice(0, 200).map((item, itemIndex) => ({ itemIndex, renderKeyHash: summarizeIdentifier(item.key).hash,
        component: item.kind === 'assistant-turn' ? 'ChatAssistantTurn' : item.kind === 'execution-graph' ? 'ExecutionGraphCard' : item.kind === 'system' ? 'SystemInfoRow' : 'ChatMessage' })),
    }));
  }, [isEmptyState, items, sessionIdentity, showBlockingError, showBlockingLoading, showThinking]);

  if (showBlockingLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center py-20">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (showBlockingError) {
    return <FailureScreen message={errorMessage} />;
  }

  const contentElementsStartedAt = tracing ? performance.now() : 0;
  const content = (
    <>
      {showLoadOlderButton && !isEmptyState ? (
        <div
          data-testid="chat-load-older-rail"
          className={CHAT_LAYOUT_TOKENS.threadTopAffordanceRail}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-none px-1.5 text-[11px] text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={onLoadOlder}
            disabled={isLoadingOlder}
          >
            {isLoadingOlder ? <LoadingSpinner size="sm" /> : null}
            {loadOlderLabel}
          </Button>
        </div>
      ) : null}

      {!isEmptyState ? (
        <>
          {items.map((item, index) => {
            const toolSlots = toolPlan.get(item.key);
            const coveredOnly = item.kind === 'assistant-turn' && isCoveredToolOnlyItem(item, toolSlots);
            return (
              <div key={item.key}>
                <div data-index={index} className={coveredOnly ? 'w-full' : CHAT_LAYOUT_TOKENS.threadMessageRowSpacing}>
                  <div {...getMessageDataAttributes(item)} className="w-full">
                    {renderChatItem({
                      item,
                      toolSlots,
                      latestBrowserTools,
                      disclosure,
                      assistantAvatarSlot: item.kind === 'assistant-turn' ? assistantAvatarSlots.get(item.key) : 'visible',
                      replyStartedAtByAssistantKey,
                      showThinking,
                      userAvatarImageUrl,
                      sessionIdentity,
                      endpointSessionId,
                      workspaceContext,
                      onJumpToItemKey,
                      artifactFilesByGraphKey,
                      onOpenArtifactFile,
                      onOpenAttachedArtifact,
                      onReuseMessage,
                      onRuntimeSendMessage,
                      onRuntimeOpenLink,
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </>
      ) : null}
      {activity ? (
        <div role="status" aria-live="polite" className="pt-6 md:pt-7">
          <MessageShell
            isUser={false}
            assistantAgentId={assistantPresentation?.agentId}
            assistantAgentName={assistantPresentation?.agentName}
            assistantAvatarSeed={assistantPresentation?.avatarSeed}
            assistantAvatarStyle={assistantPresentation?.avatarStyle}
          >
            <AssistantPendingIndicator mode={activity} />
          </MessageShell>
        </div>
      ) : null}
    </>
  );
  contentElementsBuildElapsedMs = tracing ? performance.now() - contentElementsStartedAt : null;
  return content;
});

const ChatScrollChrome = memo(function ChatScrollChrome({
  scrollChromeStore,
  showLoadOlderButton,
}: {
  scrollChromeStore: ChatScrollChromeStore;
  showLoadOlderButton: boolean;
}) {
  const { phase, visible, isAtLatest, jumpActionLabel } = useSyncExternalStore(
    scrollChromeStore.subscribe,
    scrollChromeStore.getSnapshot,
    scrollChromeStore.getSnapshot,
  );
  const showJumpToBottom = visible && (phase === 'detached' || !isAtLatest);

  if (!showJumpToBottom) {
    return null;
  }

  return (
    <div
      className={CHAT_LAYOUT_TOKENS.stageJumpToBottomRail}
      style={{ bottom: 'calc(var(--chat-composer-safe-offset, 0px) + 0.75rem)' }}
    >
      <div className={CHAT_LAYOUT_TOKENS.stageFloatingRail}>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={cn(
            'pointer-events-auto h-9 w-9 rounded-full border-border/45 bg-background text-foreground shadow-none transition-colors hover:bg-secondary',
            showLoadOlderButton && 'translate-y-1',
          )}
          onClick={scrollChromeStore.runJumpAction}
          aria-label={jumpActionLabel}
          title={jumpActionLabel}
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
});

export const ChatListSurface = memo(function ChatListSurface({
  messagesViewportRef,
  messageContentRef,
  isEmptyState,
  showBlockingLoading,
  showBlockingError,
  errorMessage,
  onPointerDown,
  onScroll,
  onTouchMove,
  onWheel,
  onViewportClickCapture,
  items,
  activity,
  assistantPresentation,
  showLoadOlder,
  isLoadingOlder,
  onLoadOlder,
  loadOlderLabel,
  scrollChromeStore,
  showThinking,
  userAvatarImageUrl,
  sessionIdentity,
  endpointSessionId,
  workspaceContext,
  onJumpToItemKey,
  artifactFilesByGraphKey = new Map<string, GeneratedFile[]>(),
  onOpenArtifactFile = () => {},
  onOpenAttachedArtifact = () => {},
  onReuseMessage,
  onRuntimeSendMessage,
  onRuntimeOpenLink,
}: ChatListSurfaceProps) {
  const showLoadOlderButton = showLoadOlder || isLoadingOlder;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={messagesViewportRef}
        className={cn(
          `min-h-0 flex-1 overflow-y-auto chat-scroll-sync-viewport ${CHAT_LAYOUT_TOKENS.threadViewportPadding}`,
        )}
        style={{
          overflowAnchor: 'none',
          scrollbarGutter: 'stable',
          paddingTop: 'var(--chat-thread-top-padding, 0px)',
          paddingBottom: 'var(--chat-thread-bottom-padding, 0px)',
        }}
        onPointerDownCapture={onPointerDown}
        onScroll={onScroll}
        onTouchMoveCapture={onTouchMove}
        onWheelCapture={onWheel}
        onClickCapture={onViewportClickCapture}
      >
        <div className={CHAT_LAYOUT_TOKENS.threadRail}>
          <div
            ref={messageContentRef}
            data-testid="chat-message-stack"
            className={cn(
              'w-full',
              !showBlockingLoading && !isEmptyState && CHAT_LAYOUT_TOKENS.threadMessageStackPaddingTop,
            )}
            style={{ overflowAnchor: 'none' }}
          >
            <ChatListContent
              isEmptyState={isEmptyState}
              showBlockingLoading={showBlockingLoading}
              showBlockingError={showBlockingError}
              errorMessage={errorMessage}
              items={items}
              activity={activity}
              assistantPresentation={assistantPresentation}
              showLoadOlder={showLoadOlder}
              isLoadingOlder={isLoadingOlder}
              onLoadOlder={onLoadOlder}
              loadOlderLabel={loadOlderLabel}
              showThinking={showThinking}
              userAvatarImageUrl={userAvatarImageUrl}
              sessionIdentity={sessionIdentity}
              endpointSessionId={endpointSessionId}
              workspaceContext={workspaceContext}
              onJumpToItemKey={onJumpToItemKey}
              artifactFilesByGraphKey={artifactFilesByGraphKey}
              onOpenArtifactFile={onOpenArtifactFile}
              onOpenAttachedArtifact={onOpenAttachedArtifact}
              onReuseMessage={onReuseMessage}
              onRuntimeSendMessage={onRuntimeSendMessage}
              onRuntimeOpenLink={onRuntimeOpenLink}
            />
          </div>
        </div>
      </div>
      <ChatScrollChrome
        scrollChromeStore={scrollChromeStore}
        showLoadOlderButton={showLoadOlderButton}
      />
    </div>
  );
});

export const ChatList = forwardRef<ChatListHandle, ChatListProps>(function ChatList(
  {
    isActive,
    currentSessionKey,
    viewport,
    items,
    activity,
    assistantPresentation,
    liveView,
    errorMessage,
    showThinking,
    userAvatarDataUrl,
    sessionIdentity,
    endpointSessionId,
    workspaceContext,
    onLoadOlder,
    loadOlderLabel,
    onJumpToLatest,
    jumpToBottomLabel,
    artifactGroups,
    onOpenArtifactFile,
    onOpenAttachedArtifact,
    onReuseMessage,
    onRuntimeSendMessage,
    onRuntimeOpenLink,
  },
  ref,
) {
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const messageContentRef = useRef<HTMLDivElement>(null);
  const olderPageAnchorRef = useRef<{
    sessionKey: string;
    sessionIdentity: SessionIdentity | undefined;
    windowStartOffset: number;
    anchor: ViewportAnchor | null;
  } | null>(null);
  const [scrollChromeStore] = useState(() => (
    createChatScrollChromeStore({
      phase: 'follow',
      visible: false,
      isAtLatest: viewport.isAtLatest,
      jumpActionLabel: jumpToBottomLabel,
    })
  ));

  const artifactFilesByGraphKey = useMemo(() => (
    new Map(artifactGroups.map((group) => [group.graphItemKey, group.files] as const))
  ), [artifactGroups]);

  const lastItem = items.at(-1);
  const lastItemSignal = lastItem
    ? `${lastItem.key}|${lastItem.renderSignature}`
    : '';
  const contentSignal = `${items.length}|${lastItemSignal}|${viewport.windowEndOffset}|${viewport.totalItemCount}|${viewport.isAtLatest ? '1' : '0'}|${viewport.hasMore ? '1' : '0'}|${viewport.hasNewer ? '1' : '0'}|${activity ?? ''}`;

  useLayoutEffect(() => {
    if (!isTraceEnabled()
      || !currentSessionKey
      || tracedFirstPaintSessionKeys.has(currentSessionKey)
      || items.length === 0
      || liveView.isEmptyState
      || liveView.showBlockingLoading
      || liveView.showBlockingError) {
      return;
    }
    const handle = window.requestAnimationFrame(() => {
      const messageContentNode = messageContentRef.current;
      const messagesViewportNode = messagesViewportRef.current;
      if (!messageContentNode?.querySelector('[data-chat-item-key]')) {
        return;
      }
      tracedFirstPaintSessionKeys.add(currentSessionKey);
      const firstItem = items[0];
      const lastPaintItem = items.at(-1);
      console.info(JSON.stringify({
        prefix: STARTUP_TRACE_PREFIX,
        traceScope: 'renderer-boundary',
        source: 'chat-list',
        phase: 'first-messages-paint',
        at: Date.now(),
        sessionKey: currentSessionKey,
        itemCount: items.length,
        totalItemCount: viewport.totalItemCount,
        windowStartOffset: viewport.windowStartOffset,
        windowEndOffset: viewport.windowEndOffset,
        hasMore: viewport.hasMore,
        hasNewer: viewport.hasNewer,
        isAtLatest: viewport.isAtLatest,
        firstItemKind: firstItem?.kind,
        firstItemKey: firstItem?.key,
        lastItemKind: lastPaintItem?.kind,
        lastItemKey: lastPaintItem?.key,
        contentHeight: messageContentNode.scrollHeight,
        viewportHeight: messagesViewportNode?.clientHeight,
      }));
    });
    return () => window.cancelAnimationFrame(handle);
  }, [
    currentSessionKey,
    items,
    liveView.isEmptyState,
    liveView.showBlockingError,
    liveView.showBlockingLoading,
    viewport.hasMore,
    viewport.hasNewer,
    viewport.isAtLatest,
    viewport.totalItemCount,
    viewport.windowEndOffset,
    viewport.windowStartOffset,
  ]);

  const {
    handleViewportPointerDown,
    handleViewportTouchMove,
    handleViewportWheel,
    handleViewportScroll,
    notifyViewportGeometryChanged,
    handleViewportClickCapture,
    prepareScopeAnchorRestore,
    prepareScopeBottomAlign,
    scrollViewportByWheelDelta,
    jumpToBottom,
  } = useChatScroll({
    enabled: isActive,
    scrollScopeKey: currentSessionKey,
    contentSignal,
    setChromePhase: scrollChromeStore.setPhase,
    viewportRef: messagesViewportRef,
    contentRef: messageContentRef,
  });

  useLayoutEffect(() => {
    const pending = olderPageAnchorRef.current;
    if (!pending) {
      return;
    }
    if (!isActive || pending.sessionKey !== currentSessionKey || pending.sessionIdentity !== sessionIdentity
      || viewport.isLoadingNewer) {
      olderPageAnchorRef.current = null;
      return;
    }
    if (viewport.windowStartOffset < pending.windowStartOffset) {
      olderPageAnchorRef.current = null;
      prepareScopeAnchorRestore(currentSessionKey, pending.anchor);
    } else if (!viewport.isLoadingMore || viewport.windowStartOffset !== pending.windowStartOffset) {
      olderPageAnchorRef.current = null;
    }
  }, [currentSessionKey, isActive, prepareScopeAnchorRestore, sessionIdentity, viewport]);

  const handleLoadOlder = useCallback(() => {
    if (!currentSessionKey || !sessionIdentity || !viewport.hasMore || viewport.isLoadingMore) {
      return;
    }
    olderPageAnchorRef.current = {
      sessionKey: currentSessionKey,
      sessionIdentity,
      windowStartOffset: viewport.windowStartOffset,
      anchor: sampleViewportAnchor(messagesViewportRef.current),
    };
    onLoadOlder();
  }, [currentSessionKey, onLoadOlder, sessionIdentity, viewport.hasMore,
    viewport.isLoadingMore, viewport.windowStartOffset]);

  const handleJumpToItemKey = useCallback((itemKey?: string) => {
    if (!itemKey) {
      return;
    }
    const viewportNode = messagesViewportRef.current;
    if (!viewportNode) {
      return;
    }
    const target = Array.from(viewportNode.querySelectorAll<HTMLElement>('[data-chat-item-key]'))
      .find((element) => element.dataset.chatItemKey === itemKey);
    if (!target) {
      return;
    }
    target.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, []);

  const handleJumpToLatestBottom = useCallback(() => {
    if (!currentSessionKey) {
      return;
    }
    olderPageAnchorRef.current = null;
    if (viewport.isAtLatest) {
      jumpToBottom();
      return;
    }
    prepareScopeBottomAlign(currentSessionKey);
    onJumpToLatest();
  }, [
    currentSessionKey,
    jumpToBottom,
    onJumpToLatest,
    prepareScopeBottomAlign,
    viewport.isAtLatest,
  ]);

  useLayoutEffect(() => {
    scrollChromeStore.setChromeState({
      visible: !liveView.isEmptyState && !liveView.showBlockingLoading && !liveView.showBlockingError,
      isAtLatest: viewport.isAtLatest,
      jumpActionLabel: jumpToBottomLabel,
    });
    scrollChromeStore.setJumpAction(handleJumpToLatestBottom);
  }, [
    jumpToBottomLabel,
    handleJumpToLatestBottom,
    liveView.isEmptyState,
    liveView.showBlockingError,
    liveView.showBlockingLoading,
    scrollChromeStore,
    viewport.isAtLatest,
  ]);

  useImperativeHandle(ref, () => ({
    prepareCurrentLatestBottomAlign: () => {
      if (!currentSessionKey) {
        return;
      }
      olderPageAnchorRef.current = null;
      prepareScopeBottomAlign(currentSessionKey);
    },
    scrollByWheelDelta: (deltaY) => {
      scrollViewportByWheelDelta(deltaY);
    },
    notifyComposerGeometryChanged: () => {
      notifyViewportGeometryChanged();
    },
  }), [currentSessionKey, notifyViewportGeometryChanged, prepareScopeBottomAlign, scrollViewportByWheelDelta]);

  return (
    <ChatListSurface
      messagesViewportRef={messagesViewportRef}
      messageContentRef={messageContentRef}
      isEmptyState={liveView.isEmptyState}
      showBlockingLoading={liveView.showBlockingLoading}
      showBlockingError={liveView.showBlockingError}
      errorMessage={errorMessage}
      onPointerDown={handleViewportPointerDown}
      onScroll={handleViewportScroll}
      onTouchMove={handleViewportTouchMove}
      onWheel={handleViewportWheel}
      onViewportClickCapture={handleViewportClickCapture}
      items={items}
      activity={activity}
      assistantPresentation={assistantPresentation}
      showLoadOlder={viewport.hasMore || viewport.isLoadingMore}
      isLoadingOlder={viewport.isLoadingMore}
      onLoadOlder={handleLoadOlder}
      loadOlderLabel={loadOlderLabel}
      scrollChromeStore={scrollChromeStore}
      showThinking={showThinking}
      userAvatarImageUrl={userAvatarDataUrl}
      sessionIdentity={sessionIdentity}
      endpointSessionId={endpointSessionId}
      workspaceContext={workspaceContext}
      onJumpToItemKey={handleJumpToItemKey}
      artifactFilesByGraphKey={artifactFilesByGraphKey}
      onOpenArtifactFile={onOpenArtifactFile}
      onOpenAttachedArtifact={onOpenAttachedArtifact}
      onReuseMessage={onReuseMessage}
      onRuntimeSendMessage={onRuntimeSendMessage}
      onRuntimeOpenLink={onRuntimeOpenLink}
    />
  );
});
