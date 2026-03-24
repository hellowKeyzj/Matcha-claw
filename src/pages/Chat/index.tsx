/**
 * Chat Page
 * Native React implementation communicating with OpenClaw Gateway
 * via gateway:rpc IPC. Session selector, thinking toggle, and refresh
 * are in the toolbar; messages render with markdown + streaming.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { AlertCircle, Bot, Loader2, MessageSquare, Settings2, Sparkles, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useChatStore, type ApprovalDecision, type ApprovalItem, type RawMessage } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSkillsStore } from '@/stores/skills';
import { useSubagentsStore } from '@/stores/subagents';
import { useSettingsStore } from '@/stores/settings';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { ChatToolbar } from './ChatToolbar';
import { TaskInboxPanel } from './components/TaskInboxPanel';
import { VerticalPaneResizer } from '@/components/layout/VerticalPaneResizer';
import { extractImages, extractText, extractThinking, extractToolUse } from './message-utils';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

const TASK_INBOX_MIN_WIDTH = 260;
const TASK_INBOX_MAX_WIDTH = 560;
const TASK_INBOX_DEFAULT_WIDTH = 360;
const TASK_INBOX_RESIZER_WIDTH = 6;
const CHAT_MAIN_MIN_WIDTH = 520;
const CHAT_STICKY_BOTTOM_THRESHOLD_PX = 120;
const CHAT_VIRTUAL_ESTIMATE_HEIGHT_PX = 168;
const CHAT_VIRTUAL_OVERSCAN = 8;
const EMPTY_APPROVAL_ITEMS: ApprovalItem[] = [];

interface AgentSkillOption {
  id: string;
  name: string;
  icon?: string;
}

interface SessionScrollSnapshot {
  atBottom: boolean;
  anchorKey?: string;
  anchorOffsetWithin?: number;
  fallbackScrollTop: number;
}

interface ChatBottomVirtualizer {
  scrollToIndex: (index: number, options: { align: 'end' }) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function loadTaskInboxWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem('chat:task-inbox-width') || TASK_INBOX_DEFAULT_WIDTH);
    if (!Number.isFinite(raw)) {
      return TASK_INBOX_DEFAULT_WIDTH;
    }
    return clamp(raw, TASK_INBOX_MIN_WIDTH, TASK_INBOX_MAX_WIDTH);
  } catch {
    return TASK_INBOX_DEFAULT_WIDTH;
  }
}

function clampTaskInboxWidth(width: number, containerWidth: number): number {
  const maxWidth = Math.max(
    TASK_INBOX_MIN_WIDTH,
    containerWidth - CHAT_MAIN_MIN_WIDTH - TASK_INBOX_RESIZER_WIDTH,
  );
  return clamp(width, TASK_INBOX_MIN_WIDTH, Math.min(TASK_INBOX_MAX_WIDTH, maxWidth));
}

function buildAgentChatSessionKey(agentId: string): string {
  const normalized = agentId.trim();
  if (!normalized) {
    return '';
  }
  return `agent:${normalized}:main`;
}

function parseAgentIdFromSessionKey(sessionKey: string): string {
  const matched = sessionKey.match(/^agent:([^:]+):/i);
  return matched?.[1] ?? 'main';
}

function resolveAgentEmoji(explicitEmoji: string | undefined, isDefault: boolean): string {
  if (explicitEmoji && explicitEmoji.trim()) {
    return explicitEmoji;
  }
  return isDefault ? '⚙️' : '🤖';
}

function resolveMessageAnchorKey(message: RawMessage, index: number): string {
  if (typeof message.id === 'string' && message.id.trim()) {
    return `id:${message.id}`;
  }
  const role = typeof message.role === 'string' ? message.role : 'unknown';
  const timestamp = typeof message.timestamp === 'number' ? message.timestamp : 'na';
  const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
  return `fallback:${role}:${timestamp}:${toolCallId}:${index}`;
}

export function scrollChatToBottom(
  messagesCount: number,
  virtualizer: ChatBottomVirtualizer,
  endRef: { current: HTMLDivElement | null },
): void {
  if (messagesCount > 0) {
    virtualizer.scrollToIndex(messagesCount - 1, { align: 'end' });
  }
  endRef.current?.scrollIntoView({ behavior: 'auto' });
}

export function shouldAutoScrollChat(
  shouldStickToBottom: boolean,
  pendingRestoreSessionKey: string | null,
  currentSessionKey: string,
): boolean {
  if (!shouldStickToBottom) {
    return false;
  }
  return pendingRestoreSessionKey == null || pendingRestoreSessionKey !== currentSessionKey;
}

export function Chat() {
  const { t } = useTranslation('chat');
  const location = useLocation();
  const navigate = useNavigate();
  const gatewayStatus = useGatewayStore((s) => s.status);
  const isGatewayRunning = gatewayStatus.state === 'running';

  const messages = useChatStore((s) => s.messages);
  const loading = useChatStore((s) => s.loading);
  const sending = useChatStore((s) => s.sending);
  const error = useChatStore((s) => s.error);
  const showThinking = useChatStore((s) => s.showThinking);
  const streamingMessage = useChatStore((s) => s.streamingMessage);
  const streamingTools = useChatStore((s) => s.streamingTools);
  const pendingFinal = useChatStore((s) => s.pendingFinal);
  const approvalStatus = useChatStore((s) => s.approvalStatus);
  const currentPendingApprovals = useChatStore((s) => s.pendingApprovalsBySession[s.currentSessionKey] ?? EMPTY_APPROVAL_ITEMS);
  const resolveApproval = useChatStore((s) => s.resolveApproval);
  const loadHistory = useChatStore((s) => s.loadHistory);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const switchSession = useChatStore((s) => s.switchSession);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const abortRun = useChatStore((s) => s.abortRun);
  const clearError = useChatStore((s) => s.clearError);
  const agents = useSubagentsStore((s) => s.agents);
  const loadAgents = useSubagentsStore((s) => s.loadAgents);
  const updateAgent = useSubagentsStore((s) => s.updateAgent);
  const skills = useSkillsStore((s) => s.skills);
  const skillsLoading = useSkillsStore((s) => s.loading);
  const fetchSkills = useSkillsStore((s) => s.fetchSkills);
  const userAvatarDataUrl = useSettingsStore((s) => s.userAvatarDataUrl);

  const cleanupEmptySession = useChatStore((s) => s.cleanupEmptySession);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const chatLayoutRef = useRef<HTMLDivElement>(null);
  const resizeRafRef = useRef<number | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const autoScrollRafRef = useRef<number | null>(null);
  const sessionScrollSnapshotRef = useRef<Map<string, SessionScrollSnapshot>>(new Map());
  const pendingScrollRestoreSessionKeyRef = useRef<string | null>(currentSessionKey);
  const [streamingTimestamp, setStreamingTimestamp] = useState<number>(0);
  const [taskInboxCollapsed, setTaskInboxCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('chat:task-inbox-collapsed') === '1';
    } catch {
      return false;
    }
  });
  const [taskInboxWidth, setTaskInboxWidth] = useState<number>(() => loadTaskInboxWidth());
  const [skillConfigOpen, setSkillConfigOpen] = useState(false);
  const [skillConfigSaving, setSkillConfigSaving] = useState(false);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const messageAnchorKeys = useMemo(
    () => messages.map((message, index) => resolveMessageAnchorKey(message, index)),
    [messages],
  );
  const messageAnchorIndexByKey = useMemo(() => {
    const map = new Map<string, number>();
    messageAnchorKeys.forEach((key, index) => {
      map.set(key, index);
    });
    return map;
  }, [messageAnchorKeys]);
  const messageVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => messagesViewportRef.current,
    estimateSize: () => CHAT_VIRTUAL_ESTIMATE_HEIGHT_PX,
    overscan: CHAT_VIRTUAL_OVERSCAN,
    getItemKey: (index) => messageAnchorKeys[index] ?? `idx:${index}`,
  });
  const virtualMessageItems = messageVirtualizer.getVirtualItems();

  useEffect(() => {
    try {
      window.localStorage.setItem('chat:task-inbox-collapsed', taskInboxCollapsed ? '1' : '0');
    } catch {
      // ignore localStorage errors
    }
  }, [taskInboxCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem('chat:task-inbox-width', String(taskInboxWidth));
    } catch {
      // ignore localStorage errors
    }
  }, [taskInboxWidth]);

  useEffect(() => {
    const applyResize = () => {
      const containerWidth = chatLayoutRef.current?.clientWidth ?? window.innerWidth;
      setTaskInboxWidth((prev) => {
        const next = clampTaskInboxWidth(prev, containerWidth);
        return next === prev ? prev : next;
      });
    };

    const scheduleResize = () => {
      if (resizeRafRef.current != null) {
        return;
      }
      resizeRafRef.current = window.requestAnimationFrame(() => {
        resizeRafRef.current = null;
        applyResize();
      });
    };

    scheduleResize();
    window.addEventListener('resize', scheduleResize);
    return () => {
      window.removeEventListener('resize', scheduleResize);
      if (resizeRafRef.current != null) {
        window.cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
    };
  }, []);

  const startTaskInboxResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (taskInboxCollapsed) {
      return;
    }
    event.preventDefault();

    const onMouseMove = (moveEvent: MouseEvent) => {
      const rect = chatLayoutRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const rawWidth = rect.right - moveEvent.clientX - TASK_INBOX_RESIZER_WIDTH;
      const next = clampTaskInboxWidth(rawWidth, rect.width);
      setTaskInboxWidth(next);
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // Load data when gateway is running.
  // When the store already holds messages for this session (i.e. the user
  // is navigating *back* to Chat), use quiet mode so the existing messages
  // stay visible while fresh data loads in the background.  This avoids
  // an unnecessary messages → spinner → messages flicker.
  useEffect(() => {
    if (!isGatewayRunning) return;
    let cancelled = false;
    const hasExistingMessages = useChatStore.getState().messages.length > 0;
    const params = new URLSearchParams(location.search);
    const sessionParam = params.get('session')?.trim() ?? '';
    const agentParam = params.get('agent')?.trim() ?? '';
    const targetSessionKey = sessionParam || buildAgentChatSessionKey(agentParam);
    (async () => {
      await loadAgents();
      await loadSessions();
      if (cancelled) return;
      if (targetSessionKey) {
        switchSession(targetSessionKey);
        navigate('/', { replace: true });
        return;
      }
      await loadHistory(hasExistingMessages);
    })();
    return () => {
      cancelled = true;
      // If the user navigates away without sending any messages, remove the
      // empty session so it doesn't linger as a ghost entry in the sidebar.
      cleanupEmptySession();
    };
  }, [cleanupEmptySession, isGatewayRunning, loadAgents, loadHistory, loadSessions, location.search, navigate, switchSession]);

  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }

    const evaluateStickiness = () => {
      const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const atBottom = distanceToBottom <= CHAT_STICKY_BOTTOM_THRESHOLD_PX;
      shouldStickToBottomRef.current = atBottom;

      const nextSnapshot: SessionScrollSnapshot = {
        atBottom,
        fallbackScrollTop: viewport.scrollTop,
      };
      if (!atBottom && messages.length > 0) {
        const virtualItems = messageVirtualizer.getVirtualItems();
        const anchorItem = virtualItems.find((item) => (item.start + item.size) > viewport.scrollTop) ?? virtualItems[0];
        if (anchorItem) {
          nextSnapshot.anchorKey = messageAnchorKeys[anchorItem.index];
          nextSnapshot.anchorOffsetWithin = Math.max(0, viewport.scrollTop - anchorItem.start);
        }
      }
      sessionScrollSnapshotRef.current.set(currentSessionKey, nextSnapshot);
    };

    evaluateStickiness();
    viewport.addEventListener('scroll', evaluateStickiness, { passive: true });
    return () => {
      viewport.removeEventListener('scroll', evaluateStickiness);
    };
  }, [currentSessionKey, messageAnchorKeys, messageVirtualizer, messages.length]);

  useEffect(() => {
    shouldStickToBottomRef.current = true;
    pendingScrollRestoreSessionKeyRef.current = currentSessionKey;
  }, [currentSessionKey]);

  useEffect(() => {
    if (pendingScrollRestoreSessionKeyRef.current !== currentSessionKey) {
      return;
    }
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }
    const snapshot = sessionScrollSnapshotRef.current.get(currentSessionKey);
    const restoreRaf = window.requestAnimationFrame(() => {
      if (pendingScrollRestoreSessionKeyRef.current !== currentSessionKey) {
        return;
      }
      if (!snapshot || snapshot.atBottom) {
        shouldStickToBottomRef.current = true;
        scrollChatToBottom(messages.length, messageVirtualizer, messagesEndRef);
        pendingScrollRestoreSessionKeyRef.current = null;
        return;
      }

      shouldStickToBottomRef.current = false;
      const anchorIndex = snapshot.anchorKey ? messageAnchorIndexByKey.get(snapshot.anchorKey) : undefined;
      if (typeof anchorIndex === 'number') {
        messageVirtualizer.scrollToIndex(anchorIndex, { align: 'start' });
        window.requestAnimationFrame(() => {
          const latestViewport = messagesViewportRef.current;
          if (!latestViewport) {
            return;
          }
          const maxTop = Math.max(0, latestViewport.scrollHeight - latestViewport.clientHeight);
          const offsetWithin = snapshot.anchorOffsetWithin ?? 0;
          latestViewport.scrollTop = Math.min(maxTop, Math.max(0, latestViewport.scrollTop + offsetWithin));
          pendingScrollRestoreSessionKeyRef.current = null;
        });
        return;
      }

      const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      viewport.scrollTop = Math.min(maxTop, Math.max(0, snapshot.fallbackScrollTop));
      pendingScrollRestoreSessionKeyRef.current = null;
    });
    return () => {
      window.cancelAnimationFrame(restoreRaf);
    };
  }, [currentSessionKey, messageAnchorIndexByKey, messageVirtualizer, messages.length]);

  // Auto-scroll on new messages, streaming, or activity changes.
  // Use auto behavior to avoid scroll animation blur/ghosting under heavy render load.
  useEffect(() => {
    if (!shouldAutoScrollChat(
      shouldStickToBottomRef.current,
      pendingScrollRestoreSessionKeyRef.current,
      currentSessionKey,
    )) {
      return;
    }
    if (autoScrollRafRef.current != null) {
      window.cancelAnimationFrame(autoScrollRafRef.current);
    }
    autoScrollRafRef.current = window.requestAnimationFrame(() => {
      if (!shouldAutoScrollChat(
        shouldStickToBottomRef.current,
        pendingScrollRestoreSessionKeyRef.current,
        currentSessionKey,
      )) {
        autoScrollRafRef.current = null;
        return;
      }
      scrollChatToBottom(messages.length, messageVirtualizer, messagesEndRef);
      autoScrollRafRef.current = null;
    });
    return () => {
      if (autoScrollRafRef.current != null) {
        window.cancelAnimationFrame(autoScrollRafRef.current);
        autoScrollRafRef.current = null;
      }
    };
  }, [currentSessionKey, messageVirtualizer, messages, sending, pendingFinal, streamingMessage]);

  // Update timestamp when sending starts
  useEffect(() => {
    if (sending && streamingTimestamp === 0) {
      setStreamingTimestamp(Date.now() / 1000);
    } else if (!sending && streamingTimestamp !== 0) {
      setStreamingTimestamp(0);
    }
  }, [sending, streamingTimestamp]);

  const streamMsg = streamingMessage && typeof streamingMessage === 'object'
    ? streamingMessage as unknown as { role?: string; content?: unknown; timestamp?: number }
    : null;
  const streamText = streamMsg ? extractText(streamMsg) : (typeof streamingMessage === 'string' ? streamingMessage : '');
  const hasStreamText = streamText.trim().length > 0;
  const streamThinking = streamMsg ? extractThinking(streamMsg) : null;
  const hasStreamThinking = showThinking && !!streamThinking && streamThinking.trim().length > 0;
  const streamTools = streamMsg ? extractToolUse(streamMsg) : [];
  const hasStreamTools = streamTools.length > 0;
  const streamImages = streamMsg ? extractImages(streamMsg) : [];
  const hasStreamImages = streamImages.length > 0;
  const hasStreamToolStatus = streamingTools.length > 0;
  const shouldRenderStreaming = sending && (hasStreamText || hasStreamThinking || hasStreamTools || hasStreamImages || hasStreamToolStatus);
  const hasAnyStreamContent = hasStreamText || hasStreamThinking || hasStreamTools || hasStreamImages || hasStreamToolStatus;
  const waitingApproval = approvalStatus === 'awaiting_approval';
  const currentAgentId = parseAgentIdFromSessionKey(currentSessionKey);
  const currentAgent = agents.find((item) => item.id === currentAgentId);
  const availableSkillOptions = useMemo<AgentSkillOption[]>(
    () => skills
      .filter((skill) => skill.enabled !== false && skill.eligible !== false)
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        icon: skill.icon,
      })),
    [skills],
  );
  const availableSkillIds = useMemo(
    () => availableSkillOptions.map((skill) => skill.id),
    [availableSkillOptions],
  );
  const availableSkillSet = useMemo(
    () => new Set(availableSkillIds),
    [availableSkillIds],
  );
  const assistantAvatarEmoji = resolveAgentEmoji(
    currentAgent?.identityEmoji ?? currentAgent?.identity?.emoji,
    Boolean(currentAgent?.isDefault),
  );
  const openSkillConfigDialog = useCallback(() => {
    if (!currentAgent) {
      return;
    }
    setSkillConfigOpen(true);
    if (skills.length === 0 && !skillsLoading) {
      void fetchSkills();
    }
  }, [currentAgent, fetchSkills, skills.length, skillsLoading]);

  useEffect(() => {
    if (!skillConfigOpen || !currentAgent) {
      return;
    }
    const currentSkills = Array.isArray(currentAgent.skills)
      ? currentAgent.skills
      : availableSkillIds;
    const normalized = Array.from(new Set(currentSkills.filter((id) => availableSkillSet.has(id))));
    setSelectedSkillIds(normalized);
  }, [availableSkillIds, availableSkillSet, currentAgent, skillConfigOpen]);

  const handleSaveSkillConfig = useCallback(async () => {
    if (!currentAgent) {
      return;
    }
    setSkillConfigSaving(true);
    try {
      await updateAgent({
        agentId: currentAgent.id,
        name: currentAgent.name || currentAgent.id,
        workspace: currentAgent.workspace ?? '',
        model: currentAgent.model,
        skills: selectedSkillIds,
      });
      setSkillConfigOpen(false);
    } finally {
      setSkillConfigSaving(false);
    }
  }, [currentAgent, selectedSkillIds, updateAgent]);

  // Gateway not running
  if (!isGatewayRunning) {
    return (
      <div className="flex h-[calc(100vh-8rem)] flex-col items-center justify-center text-center p-8">
        <AlertCircle className="h-12 w-12 text-yellow-500 mb-4" />
        <h2 className="text-xl font-semibold mb-2">{t('gatewayNotRunning')}</h2>
        <p className="text-muted-foreground max-w-md">
          {t('gatewayRequired')}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={chatLayoutRef}
      className={cn(
        'grid h-full min-h-0 grid-cols-1 overflow-hidden xl:[grid-template-columns:minmax(0,1fr)_var(--task-inbox-resizer-width)_var(--task-inbox-width)]',
        taskInboxCollapsed ? 'xl:[grid-template-columns:minmax(0,1fr)_52px]' : '',
      )}
      style={{
        ['--task-inbox-width' as string]: `${taskInboxWidth}px`,
        ['--task-inbox-resizer-width' as string]: `${TASK_INBOX_RESIZER_WIDTH}px`,
      }}
    >
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-end px-4 py-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mr-2 h-8"
            disabled={!currentAgent}
            onClick={openSkillConfigDialog}
          >
            <Settings2 className="mr-1 h-3.5 w-3.5" />
            {t('toolbar.skillConfig')}
          </Button>
          <ChatToolbar />
        </div>

        <div ref={messagesViewportRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mx-auto max-w-4xl">
            {loading && !sending ? (
              <div className="flex h-full items-center justify-center py-20">
                <LoadingSpinner size="lg" />
              </div>
            ) : messages.length === 0 && !sending ? (
              <WelcomeScreen />
            ) : (
              <>
                <div
                  className="relative w-full"
                  style={{ height: messageVirtualizer.getTotalSize() }}
                >
                  {virtualMessageItems.map((virtualItem) => {
                    const message = messages[virtualItem.index];
                    if (!message) {
                      return null;
                    }
                    return (
                      <div
                        key={virtualItem.key}
                        data-index={virtualItem.index}
                        ref={messageVirtualizer.measureElement}
                        className="absolute left-0 top-0 w-full pb-4"
                        style={{ transform: `translateY(${virtualItem.start}px)` }}
                      >
                        <ChatMessage
                          message={message}
                          showThinking={showThinking}
                          assistantAvatarEmoji={assistantAvatarEmoji}
                          userAvatarImageUrl={userAvatarDataUrl}
                        />
                      </div>
                    );
                  })}
                </div>

                <div className="space-y-4">
                  {shouldRenderStreaming && (
                    <ChatMessage
                      message={(streamMsg
                        ? {
                            ...(streamMsg as Record<string, unknown>),
                            role: (typeof streamMsg.role === 'string' ? streamMsg.role : 'assistant') as RawMessage['role'],
                            content: streamMsg.content ?? streamText,
                            timestamp: streamMsg.timestamp ?? streamingTimestamp,
                          }
                        : {
                            role: 'assistant',
                            content: streamText,
                            timestamp: streamingTimestamp,
                          }) as RawMessage}
                      showThinking={showThinking}
                      isStreaming
                      streamingTools={streamingTools}
                      assistantAvatarEmoji={assistantAvatarEmoji}
                      userAvatarImageUrl={userAvatarDataUrl}
                    />
                  )}

                  {sending && pendingFinal && !waitingApproval && !shouldRenderStreaming && (
                    <ActivityIndicator />
                  )}

                  {sending && !pendingFinal && !waitingApproval && !hasAnyStreamContent && (
                    <TypingIndicator />
                  )}
                </div>
              </>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {error && (
          <div className="border-t border-destructive/20 bg-destructive/10 px-4 py-2">
            <div className="mx-auto flex max-w-4xl items-center justify-between">
              <p className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {error}
              </p>
              <button
                onClick={clearError}
                className="text-xs text-destructive/60 underline hover:text-destructive"
              >
                {t('common:actions.dismiss')}
              </button>
            </div>
          </div>
        )}

        {waitingApproval && (
          <div className="border-t border-primary/20 bg-card/70 px-4 py-3" data-testid="chat-approval-dock">
            <div className="mx-auto max-w-4xl">
              <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                <span>{t('approval.waitingLabel')}</span>
              </div>
              {currentPendingApprovals.length > 0 && (
                <ApprovalActionsPanel
                  approvals={currentPendingApprovals}
                  onResolve={(id, decision) => void resolveApproval(id, decision)}
                />
              )}
            </div>
          </div>
        )}

        <ChatInput
          onSend={sendMessage}
          onStop={abortRun}
          disabled={!isGatewayRunning}
          sending={sending}
          approvalWaiting={waitingApproval}
        />

        <AgentSkillConfigDialog
          open={skillConfigOpen}
          title={t('skillConfigDialog.titleWithAgent', { agent: currentAgent?.name || currentAgentId })}
          skillOptions={availableSkillOptions}
          skillsLoading={skillsLoading}
          selectedSkillIds={selectedSkillIds}
          submitting={skillConfigSaving}
          onToggleSkill={(skillId, checked) => {
            setSelectedSkillIds((prev) => {
              if (checked) {
                if (prev.includes(skillId)) {
                  return prev;
                }
                return [...prev, skillId];
              }
              return prev.filter((id) => id !== skillId);
            });
          }}
          onClose={() => setSkillConfigOpen(false)}
          onSubmit={() => {
            void handleSaveSkillConfig();
          }}
        />
      </div>

      {!taskInboxCollapsed && (
        <VerticalPaneResizer
          testId="chat-right-resizer"
          className="hidden xl:block"
          onMouseDown={startTaskInboxResize}
          ariaLabel="Resize task inbox"
          variant="subtle-border"
        />
      )}

      <TaskInboxPanel
        collapsed={taskInboxCollapsed}
        onToggleCollapse={() => setTaskInboxCollapsed((prev) => !prev)}
      />
    </div>
  );
}

function AgentSkillConfigDialog({
  open,
  title,
  skillOptions,
  skillsLoading,
  selectedSkillIds,
  submitting,
  onToggleSkill,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  skillOptions: AgentSkillOption[];
  skillsLoading: boolean;
  selectedSkillIds: string[];
  submitting: boolean;
  onToggleSkill: (skillId: string, checked: boolean) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation('chat');
  if (!open) {
    return null;
  }
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <section
        role="dialog"
        aria-label={title}
        className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-xl border bg-background p-5 shadow-xl"
      >
        <header className="flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('common:actions.close')}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </header>
        <div className="mt-4 rounded-lg border bg-muted/20 p-3">
          {skillsLoading ? (
            <p className="text-sm text-muted-foreground">{t('skillConfigDialog.loading')}</p>
          ) : skillOptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('skillConfigDialog.empty')}</p>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {skillOptions.map((skill) => {
                const checked = selectedSkillIds.includes(skill.id);
                const inputId = `chat-agent-skill-${skill.id}`;
                return (
                  <label
                    key={skill.id}
                    htmlFor={inputId}
                    className={cn(
                      'flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm',
                      checked ? 'border-primary bg-primary/5' : 'border-border bg-background',
                    )}
                  >
                    <input
                      id={inputId}
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => onToggleSkill(skill.id, event.target.checked)}
                    />
                    <span aria-hidden>{skill.icon?.trim() || '🧩'}</span>
                    <span className="truncate">{skill.name}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2 border-t pt-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            {t('skillConfigDialog.cancel')}
          </Button>
          <Button type="button" onClick={onSubmit} disabled={submitting}>
            {t('skillConfigDialog.save')}
          </Button>
        </div>
      </section>
    </div>
  );
}

// ── Welcome Screen ──────────────────────────────────────────────

function WelcomeScreen() {
  const { t } = useTranslation('chat');
  return (
    <div className="flex flex-col items-center justify-center text-center py-20">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-sky-500 to-blue-600 flex items-center justify-center mb-6">
        <Bot className="h-8 w-8 text-white" />
      </div>
      <h2 className="text-2xl font-bold mb-2">{t('welcome.title')}</h2>
      <p className="text-muted-foreground mb-8 max-w-md">
        {t('welcome.subtitle')}
      </p>

      <div className="grid grid-cols-2 gap-4 max-w-lg w-full">
        {[
          { icon: MessageSquare, title: t('welcome.askQuestions'), desc: t('welcome.askQuestionsDesc') },
          { icon: Sparkles, title: t('welcome.creativeTasks'), desc: t('welcome.creativeTasksDesc') },
        ].map((item, i) => (
          <Card key={i} className="text-left">
            <CardContent className="p-4">
              <item.icon className="h-6 w-6 text-primary mb-2" />
              <h3 className="font-medium">{item.title}</h3>
              <p className="text-sm text-muted-foreground">{item.desc}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── Typing Indicator ────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-blue-600 text-white">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="bg-muted rounded-2xl px-4 py-3">
        <div className="flex gap-1">
          <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    </div>
  );
}

// ── Activity Indicator (shown between tool cycles) ─────────────

function ActivityIndicator() {
  const label = 'Processing tool results...';
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-blue-600 text-white">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="bg-muted rounded-2xl px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          <span>{label}</span>
        </div>
      </div>
    </div>
  );
}

function ApprovalActionsPanel({
  approvals,
  onResolve,
}: {
  approvals: ApprovalItem[];
  onResolve: (id: string, decision: ApprovalDecision) => void;
}) {
  const { t } = useTranslation('chat');
  return (
    <div className="w-full rounded-xl border border-primary/20 bg-background/80 p-3">
      <div className="mb-2 text-sm font-medium text-foreground">{t('approval.panelTitle')}</div>
      <div className="space-y-2">
        {approvals.map((approval) => (
          <div key={approval.id} className="rounded-lg border border-border/70 bg-background/70 p-2">
            <div className="mb-2 text-xs text-muted-foreground">
              {t('approval.pendingTool', { tool: approval.toolName || t('approval.unknownTool') })}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onResolve(approval.id, 'allow-once')}
                className="rounded-md border border-primary/25 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition hover:bg-primary/15"
              >
                {t('approval.allowOnce')}
              </button>
              <button
                type="button"
                onClick={() => onResolve(approval.id, 'allow-always')}
                className="rounded-md border border-primary/25 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition hover:bg-primary/15"
              >
                {t('approval.allowAlways')}
              </button>
              <button
                type="button"
                onClick={() => onResolve(approval.id, 'deny')}
                className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive transition hover:bg-destructive/15"
              >
                {t('approval.deny')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default Chat;
