import { MESSAGE_LAYOUT_TOKENS } from '@/plugins/message-rendering/message-layout-tokens';
import { isTraceEnabled } from '@/lib/trace-logger';
import {
  Component,
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
  type ReactNode,
  type RefObject,
  type TouchEventHandler,
  type WheelEventHandler,
} from 'react';
import { ArrowDown } from 'lucide-react';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getSessionTextModel, type SessionTextModel } from '@/plugins/chat/store/session-presentation';
import { buildThreadPresentation, type ThreadItemPresentation } from '@/plugins/chat/thread-presentation';
import { buildThreadWorkPlan, type ThreadWorkPresentation } from '@/plugins/chat/thread-work';
import { isRunActive } from '@/plugins/chat/store/types';
import { CHAT_LAYOUT_TOKENS } from '@/plugins/chat/chat-layout-tokens';
import { createChatScrollChromeStore, type ChatScrollChromeStore } from '@/plugins/chat/chat-scroll-chrome-store';
import type {
  ChatAssistantPresentation,
  ChatExecutionGraphItem,
  ChatRenderItem,
  ChatUserMessageItem,
} from '@/plugins/message-rendering/chat-render-item-model';
import { ChatMessage } from '@/plugins/message-rendering/ChatMessage';
import { ChatAssistantTurn } from '@/plugins/chat/components/ChatAssistantTurn';
import { useToolActivityDisclosure } from '@/plugins/message-rendering/useToolActivityDisclosure';
import { useTranslation } from 'react-i18next';
import { buildToolGroupPlan, selectLatestBrowserTools } from '@/plugins/chat/tool-group-plan';
import type { ToolGroupPlan, ToolSlot } from '@/plugins/message-rendering/tool-groups';
import type { SessionRenderToolCard } from '@/types/session/tool-card';
import type { ToolActivityDisclosure } from '@/plugins/message-rendering/tool-renderers/types';
import { MessageShell, type MessageAvatarSlot } from '@/plugins/message-rendering/chat-message-shell';
import { ExecutionGraphCard } from '@/plugins/message-rendering/ExecutionGraphCard';
import { useChatScroll } from '@/plugins/chat/useChatScroll';
import { sampleViewportAnchor, type ViewportAnchor } from '@/plugins/chat/chat-scroll-model';
import type { UseChatViewResult } from '@/plugins/chat/useChatView';
import { FailureScreen } from '@/plugins/chat/components/ChatStates';
import { AssistantPendingIndicator } from '@/plugins/chat/components/AssistantPendingIndicator';
import type { ChatSessionPending } from '@/plugins/chat/store/types';
import type { SessionRunTiming } from '@/types/session/snapshot';
import type { ChatArtifactGroup } from '@/plugins/chat/artifacts';
import type { AttachedFileMeta } from '@/plugins/message-rendering/attachments';
import type { ChatSessionRuntimeState, ChatSessionViewportState } from '@/plugins/chat/store';
import {
  buildSessionIdentityKey,
  type SessionIdentity,
} from '@/types/desktop/runtime-address';
import type { WorkspaceFileContext } from '@/lib/host-api';
import type { GeneratedFile } from '@/plugins/files/generated-files';
import { isSessionTraceEnabled, logSessionTrace, summarizeIdentifier, summarizeRenderItems, summarizeSessionIdentity } from '@/lib/session-trace';

const EMPTY_ARTIFACT_FILES: GeneratedFile[] = [];
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
  scrollScopeKey?: string;
  runtime: ChatSessionRuntimeState;
  viewport: ChatSessionViewportState;
  items: ChatRenderItem[];
  runTimings?: readonly SessionRunTiming[];
  activeRunId?: string | null;
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
  onOpenAttachedArtifact: (file: AttachedFileMeta) => boolean | void;
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
  runtime: ChatSessionRuntimeState;
  isAtLatest: boolean;
  runTimings?: readonly SessionRunTiming[];
  activeRunId?: string | null;
  activity?: Extract<ChatSessionPending, { kind: 'activity' }>['mode'] | null;
  assistantPresentation?: ChatAssistantPresentation;
  onBeforeWorkChange?: () => void;
  onAfterWorkChange?: () => void;
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
  onOpenAttachedArtifact: (file: AttachedFileMeta) => boolean | void;
  onReuseMessage?: (text: string) => void;
  onRuntimeSendMessage?: (text: string) => void | Promise<void>;
  onRuntimeOpenLink?: (url: string) => void | Promise<void>;
}

type ChatListContentProps = Omit<
  ChatListSurfaceProps,
  'messagesViewportRef' | 'messageContentRef' | 'onPointerDown' | 'onScroll' | 'onTouchMove' | 'onWheel' | 'onViewportClickCapture' | 'scrollChromeStore'
>;

// React's before-mutation lifecycle samples geometry before any child is hidden.
class WorkGeometrySnapshot extends Component<{
  scope: string | null;
  signal: string;
  onBefore?: () => void;
  onAfter?: () => void;
  children: ReactNode;
}> {
  getSnapshotBeforeUpdate(previous: Readonly<WorkGeometrySnapshot['props']>) {
    const changed = previous.scope === this.props.scope && previous.signal !== this.props.signal;
    if (changed) this.props.onBefore?.();
    return changed;
  }

  componentDidUpdate(_previous: Readonly<WorkGeometrySnapshot['props']>, _state: unknown, changed: boolean) {
    if (changed) this.props.onAfter?.();
  }

  render() { return this.props.children; }
}

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

function SystemInfoRow({ item }: { item: ChatRenderItem }) {
  const { t } = useTranslation('chat');
  const text = item.kind === 'system' && item.notice === 'restart-recovery' ? t('systemNotice.restartRecovery') : item.text.trim();
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

const ChatItem = memo(function ChatItem(input: {
  item: ChatRenderItem;
  index: number;
  spacing: ThreadItemPresentation['spacing'];
  toolSlots?: ReadonlyMap<string, ToolSlot>;
  latestBrowserTools: ReadonlySet<SessionRenderToolCard>;
  disclosure: ToolActivityDisclosure;
  workDisclosure: ToolActivityDisclosure;
  work?: ThreadWorkPresentation;
  assistantAvatarSlot?: MessageAvatarSlot;
  timing: ThreadItemPresentation['timing'];
  footer: ThreadItemPresentation['footer'];
  view: ThreadItemPresentation['view'];
  showThinking: boolean;
  userAvatarImageUrl: string | null;
  sessionIdentity?: SessionIdentity;
  endpointSessionId?: string | null;
  workspaceContext?: WorkspaceFileContext;
  onJumpToItemKey: (itemKey?: string) => void;
  artifactFiles: GeneratedFile[];
  onOpenArtifactFile?: (file: GeneratedFile) => void;
  onOpenAttachedArtifact: (file: AttachedFileMeta) => boolean | void;
  onReuseMessage?: (text: string) => void;
  onRuntimeSendMessage?: (text: string) => void | Promise<void>;
  onRuntimeOpenLink?: (url: string) => void | Promise<void>;
}) {
  let content: ReactNode;
  if (input.item.kind === 'assistant-turn') {
    content = (
      <ChatAssistantTurn
        item={input.item}
        toolSlots={input.toolSlots}
        latestBrowserTools={input.latestBrowserTools}
        disclosure={input.disclosure}
        work={input.work}
        workDisclosure={input.workDisclosure}
        showThinking={input.showThinking}
        timing={input.timing}
        footer={input.footer}
        view={input.view ?? undefined}
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
  } else if (input.item.kind === 'execution-graph') {
    const item = input.item as ChatExecutionGraphItem;
    content = (
      <div
        data-testid="chat-execution-graph-rail"
        className={cn(
          MESSAGE_LAYOUT_TOKENS.messageShell,
          MESSAGE_LAYOUT_TOKENS.messageShellAssistantColumns,
        )}
      >
        <div
          aria-hidden="true"
          className={cn(
            MESSAGE_LAYOUT_TOKENS.messageAvatar,
            MESSAGE_LAYOUT_TOKENS.messageAvatarAssistantOrder,
            'pointer-events-none opacity-0',
          )}
        />
        <div
          className={cn(
            MESSAGE_LAYOUT_TOKENS.messageContentColumn,
            MESSAGE_LAYOUT_TOKENS.messageContentAssistantOrder,
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
            artifactFiles={input.artifactFiles}
            onOpenArtifactFile={input.onOpenArtifactFile}
          />
        </div>
      </div>
    );
  } else if (input.item.kind === 'system') {
    content = <SystemInfoRow item={input.item} />;
  } else {
    content = (
      <ChatMessage
        item={input.item as ChatUserMessageItem}
        onReuseMessage={input.onReuseMessage}
        onOpenFile={input.onOpenAttachedArtifact}
        userAvatarImageUrl={input.userAvatarImageUrl}
        sessionIdentity={input.sessionIdentity}
        endpointSessionId={input.endpointSessionId}
      />
    );
  }
  const hiddenWorkRow = input.work && !input.work.headSegmentKey && !input.workDisclosure.expandedKeys.has(input.work.key)
    && input.footer === null && !!input.view?.segments.length && input.view.segments.every((segment) => input.work!.segmentKeys.has(segment.key));
  return (
    <div hidden={hiddenWorkRow || undefined}>
      <div data-index={input.index} className={input.spacing}>
        <div {...getMessageDataAttributes(input.item)} className="w-full">
          {content}
        </div>
      </div>
    </div>
  );
});

const ChatListContent = memo(function ChatListContent({
  isEmptyState,
  showBlockingLoading,
  showBlockingError,
  errorMessage,
  items,
  runtime,
  isAtLatest,
  runTimings,
  onBeforeWorkChange,
  onAfterWorkChange,
  activeRunId,
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
  const workDisclosure = useToolActivityDisclosure(sessionIdentity);
  const identityKey = sessionIdentity ? buildSessionIdentityKey(sessionIdentity) : null;
  const committedPresentation = useRef<{
    identityKey: string | null;
    plan: ToolGroupPlan;
    latestBrowserTools: ReadonlySet<SessionRenderToolCard>;
    rows: ThreadItemPresentation[];
    workPlan: ReadonlyMap<string, ThreadWorkPresentation>;
    showThinking: boolean;
    textModel: SessionTextModel;
  } | null>(null);
  const { toolPlan, latestBrowserTools } = useMemo(() => {
    const previous = committedPresentation.current?.identityKey === identityKey ? committedPresentation.current : null;
    const toolPlan = buildToolGroupPlan(items, previous?.plan);
    const selected = selectLatestBrowserTools(items, sessionIdentity);
    const previousLatest = previous?.latestBrowserTools;
    let latestBrowserTools = previousLatest?.size === selected.size ? previousLatest : selected;
    if (latestBrowserTools === previousLatest) {
      for (const tool of selected) {
        if (!previousLatest.has(tool)) {
          latestBrowserTools = selected;
          break;
        }
      }
    }
    return { toolPlan, latestBrowserTools };
  }, [identityKey, items, sessionIdentity]);
  const itemPresentation = useMemo(() => buildThreadPresentation(items, showThinking, textModel, toolPlan,
    committedPresentation.current?.identityKey === identityKey ? committedPresentation.current : undefined, runTimings, activeRunId),
  [identityKey, items, showThinking, textModel, toolPlan, runTimings, activeRunId]);
  const runWorking = isAtLatest && (isRunActive(runtime) || !!activity || !!runtime.imageGeneration?.active);
  const workPlan = useMemo(() => buildThreadWorkPlan(itemPresentation, runWorking,
    committedPresentation.current?.identityKey === identityKey ? committedPresentation.current.workPlan : undefined),
  [identityKey, itemPresentation, runWorking]);
  const workTimingFooters = useMemo(() => {
    const footers = new Set<string>();
    const timings = new Set<string>();
    for (const row of itemPresentation) {
      const workTiming = workPlan.get(row.item.key)?.timing;
      if (workTiming?.kind === 'finished') timings.add(JSON.stringify([workTiming.startedAtMs, workTiming.endedAtMs]));
      if (row.footer === null) continue;
      if (row.timing?.kind === 'finished' && timings.has(JSON.stringify([row.timing.startedAtMs, row.timing.endedAtMs]))) footers.add(row.item.key);
      timings.clear();
    }
    return footers;
  }, [itemPresentation, workPlan]);
  const workSignal = useMemo(() => [...workPlan].map(([itemKey, work]) => JSON.stringify([itemKey, [...work.segmentKeys], workDisclosure.expandedKeys.has(work.key)])).join('|'), [workPlan, workDisclosure.expandedKeys]);
  useLayoutEffect(() => {
    committedPresentation.current = { identityKey, plan: toolPlan, latestBrowserTools, rows: itemPresentation, workPlan, showThinking, textModel };
  }, [identityKey, latestBrowserTools, toolPlan, itemPresentation, workPlan, showThinking, textModel]);
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
  const activityTiming = activity && activeRunId
    ? runTimings?.find((timing) => timing.runId === activeRunId) : undefined;
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
          {itemPresentation.map(({ item, toolSlots, spacing, assistantAvatarSlot, timing, footer, view }, index) => (
            <ChatItem
              key={item.key}
              item={item}
              index={index}
              spacing={spacing}
              toolSlots={toolSlots}
              latestBrowserTools={latestBrowserTools}
              disclosure={disclosure}
              assistantAvatarSlot={assistantAvatarSlot}
              work={workPlan.get(item.key)}
              workDisclosure={workDisclosure}
              timing={workTimingFooters.has(item.key) ? undefined : timing}
              footer={footer}
              view={view}
              showThinking={showThinking}
              userAvatarImageUrl={userAvatarImageUrl}
              sessionIdentity={sessionIdentity}
              endpointSessionId={endpointSessionId}
              workspaceContext={workspaceContext}
              onJumpToItemKey={onJumpToItemKey}
              artifactFiles={item.kind === 'execution-graph' ? artifactFilesByGraphKey.get(item.key) ?? EMPTY_ARTIFACT_FILES : EMPTY_ARTIFACT_FILES}
              onOpenArtifactFile={item.kind === 'execution-graph' ? onOpenArtifactFile : undefined}
              onOpenAttachedArtifact={onOpenAttachedArtifact}
              onReuseMessage={onReuseMessage}
              onRuntimeSendMessage={onRuntimeSendMessage}
              onRuntimeOpenLink={onRuntimeOpenLink}
            />
          ))}
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
            <AssistantPendingIndicator mode={activity} timing={activityTiming ? { kind: 'running', startedAtMs: activityTiming.startedAtMs } : undefined} />
          </MessageShell>
        </div>
      ) : null}
    </>
  );
  contentElementsBuildElapsedMs = tracing ? performance.now() - contentElementsStartedAt : null;
  return <WorkGeometrySnapshot scope={identityKey} signal={workSignal} onBefore={onBeforeWorkChange} onAfter={onAfterWorkChange}>{content}</WorkGeometrySnapshot>;
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
  runtime,
  isAtLatest,
  runTimings,
  onBeforeWorkChange,
  onAfterWorkChange,
  activeRunId,
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
              !showBlockingLoading && !isEmptyState && `${CHAT_LAYOUT_TOKENS.threadMessageStackPaddingTop} pb-6`,
            )}
            style={{ overflowAnchor: 'none' }}
          >
            <ChatListContent
              isEmptyState={isEmptyState}
              showBlockingLoading={showBlockingLoading}
              showBlockingError={showBlockingError}
              errorMessage={errorMessage}
              items={items}
              runtime={runtime}
              isAtLatest={isAtLatest}
              onBeforeWorkChange={onBeforeWorkChange}
              onAfterWorkChange={onAfterWorkChange}
              runTimings={runTimings}
              activeRunId={activeRunId}
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
    scrollScopeKey = currentSessionKey,
    viewport,
    items,
    runtime,
    runTimings,
    activeRunId,
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
  const identityKey = sessionIdentity ? buildSessionIdentityKey(sessionIdentity) : null;
  const olderPageAnchorRef = useRef<{
    sessionKey: string;
    identityKey: string;
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
    prepareContentAnchorRestore,
    prepareScopeAnchorRestore,
    prepareScopeBottomAlign,
    scrollViewportByWheelDelta,
    jumpToBottom,
  } = useChatScroll({
    enabled: isActive,
    scrollScopeKey,
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
    if (!isActive || pending.sessionKey !== currentSessionKey || pending.identityKey !== identityKey
      || viewport.isLoadingNewer) {
      olderPageAnchorRef.current = null;
      return;
    }
    if (viewport.windowStartOffset < pending.windowStartOffset) {
      olderPageAnchorRef.current = null;
      prepareScopeAnchorRestore(scrollScopeKey, pending.anchor);
    } else if (!viewport.isLoadingMore || viewport.windowStartOffset !== pending.windowStartOffset) {
      olderPageAnchorRef.current = null;
    }
  }, [currentSessionKey, identityKey, isActive, prepareScopeAnchorRestore, scrollScopeKey, viewport]);

  const handleLoadOlder = useCallback(() => {
    if (!currentSessionKey || !identityKey || !viewport.hasMore || viewport.isLoadingMore) {
      return;
    }
    olderPageAnchorRef.current = {
      sessionKey: currentSessionKey,
      identityKey,
      windowStartOffset: viewport.windowStartOffset,
      anchor: sampleViewportAnchor(messagesViewportRef.current),
    };
    onLoadOlder();
  }, [currentSessionKey, identityKey, onLoadOlder, viewport.hasMore,
    viewport.isLoadingMore, viewport.windowStartOffset]);

  const handleJumpToItemKey = useCallback((itemKey?: string) => {
    if (!itemKey) {
      return;
    }
    const viewportNode = messagesViewportRef.current;
    if (!viewportNode) {
      return;
    }
    const target = viewportNode.querySelector<HTMLElement>(`[data-chat-item-key="${CSS.escape(itemKey)}"]`);
    if (!target) {
      return;
    }
    const summaries = new Set<HTMLButtonElement>();
    for (const hidden of target.querySelectorAll<HTMLElement>('[data-chat-work-key][hidden]')) {
      const key = hidden.dataset.chatWorkKey;
      const summary = viewportNode.querySelector<HTMLButtonElement>(`[data-chat-work-summary="true"][data-chat-work-key="${CSS.escape(key ?? '')}"]`);
      if (summary) summaries.add(summary);
    }
    for (const summary of summaries) summary.click();
    // Disclosure commits before the next paint; locate the original item after expansion.
    window.requestAnimationFrame(() => {
      if (target.isConnected && viewportNode.contains(target)) target.scrollIntoView({ block: 'start', behavior: 'auto' });
    });
  }, []);

  const handleJumpToLatestBottom = useCallback(() => {
    if (!scrollScopeKey) {
      return;
    }
    olderPageAnchorRef.current = null;
    if (!currentSessionKey || viewport.isAtLatest) {
      jumpToBottom();
      return;
    }
    prepareScopeBottomAlign(scrollScopeKey);
    onJumpToLatest();
  }, [
    currentSessionKey,
    scrollScopeKey,
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
      if (!scrollScopeKey) {
        return;
      }
      olderPageAnchorRef.current = null;
      prepareScopeBottomAlign(scrollScopeKey);
    },
    scrollByWheelDelta: (deltaY) => {
      scrollViewportByWheelDelta(deltaY);
    },
    notifyComposerGeometryChanged: () => {
      notifyViewportGeometryChanged();
    },
  }), [notifyViewportGeometryChanged, prepareScopeBottomAlign, scrollScopeKey, scrollViewportByWheelDelta]);

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
      runtime={runtime}
      isAtLatest={viewport.isAtLatest}
      onBeforeWorkChange={prepareContentAnchorRestore}
      onAfterWorkChange={notifyViewportGeometryChanged}
      runTimings={runTimings}
      activeRunId={activeRunId}
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
