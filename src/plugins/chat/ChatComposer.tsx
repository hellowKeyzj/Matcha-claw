import { memo, use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useContributions } from '@/plugin-host/react';
import { chatComposerContent, type ChatComposerContentProps, type ChatComposerContribution } from './extensions';
import { useChatStore } from '@/plugins/chat/store';
import { selectCurrentChatSendGate, selectRuntimeAgentScope } from '@/plugins/chat/store/selectors';
import { hasPendingSessionSend } from '@/plugins/chat/store/session-presentation';
import { currentSessionSend } from '@/plugins/chat/store/send-state';
import { isRunActive } from '@/plugins/chat/store/types';
import { supportsSessionGoal } from '@/plugins/runtime/directory';
import { useGatewayStore } from '@/plugins/runtime/store';
import { useSubagentsStore } from '@/plugins/agents/stores/subagents';
import { getProviderAccountRuntimeReport, useProviderStore } from '@/plugins/providers/stores/providers';
import { useComposerDraftStore } from '@/plugins/chat/composer-drafts';
import { agentScope, buildCapabilityScopeKey, buildSessionIdentityKey, runtimeEndpointsEqual, runtimeInstanceScope, sessionIdentitiesEqual, sessionScope } from '@/types/desktop/runtime-address';
import { getSessionApprovalStatus } from '@/plugins/chat/store/store-state-helpers';
import { ChatInput, type ChatInputHandle } from '@/plugins/chat/ChatInput';
import type { ChatListHandle } from '@/plugins/chat/components/ChatList';
import { useAgentSkillConfig } from '@/plugins/chat/useAgentSkillConfig';
import { useChatGoals } from '@/plugins/chat/useChatGoals';
import { useChatPermissions } from '@/plugins/chat/useChatPermissions';
import { useChatThinking } from '@/plugins/chat/useChatThinking';
import { ChatGoalDock } from '@/plugins/chat/ChatGoalDock';
import { hostApiFetch, hostCapabilityDescribe } from '@/lib/host-api';
import { toast } from 'sonner';
import { createSessionTraceId, logSessionTrace, summarizeError, summarizeIdentifier, summarizeSessionIdentity, isSessionTraceEnabled } from '@/lib/session-trace';
import { buildChatContextUsageViewModel } from '@/plugins/chat/context-usage';
import { resolveModelCatalogEntry } from '@/plugins/providers/services/provider-models';
import { providerDiagnosticError } from '@/plugins/providers/domain/provider-projection-errors';
import { CHAT_LAYOUT_TOKENS } from '@/plugins/chat/chat-layout-tokens';
import { isGatewayOperational } from '@/plugins/runtime/gateway-status';
import { selectChatComposerFacts, selectChatSelection, selectChatSession, useChatAgent, useChatRuntime } from '@/plugins/chat/chat-session';

type ChatSkillPreviewState = {
  skillId: string;
  skillName: string;
  markdown: string | null;
  loading: boolean;
  error: string | null;
  filePath?: string;
};
const EMPTY_AGENTS: never[] = [];
const composerLoads = new WeakMap<readonly ChatComposerContribution[], Promise<readonly { id: string; component: ComponentType<ChatComposerContentProps> }[]>>();

function ChatComposerContributions({ children, ...context }: ChatComposerContentProps) {
  const contributions = useContributions(chatComposerContent);
  let loaded = composerLoads.get(contributions);
  if (!loaded) {
    loaded = Promise.all([...contributions].sort((a, b) => a.order - b.order).map(async (entry) => ({
      id: entry.id, component: await entry.load(),
    })));
    composerLoads.set(contributions, loaded);
  }
  const content = use(loaded);
  const render = (index: number, preceding: ReactNode): ReactNode => {
    const entry = content[index];
    if (!entry) return children(preceding);
    const Content = entry.component;
    return <Content key={entry.id} {...context}>
      {(next) => render(index + 1, <>{preceding}{next}</>)}
    </Content>;
  };
  return render(0, null);
}

export const ChatComposer = memo(function ChatComposer({ isActive, composerRef, viewportPaneRef, children }: {
  isActive: boolean;
  composerRef: RefObject<ChatInputHandle | null>;
  viewportPaneRef: RefObject<ChatListHandle | null>;
  children: (renderInput: (topContent: ReactNode) => ReactNode) => ReactNode;
}) {
  const { t } = useTranslation('chat');
  const focusComposer = useCallback(() => composerRef.current?.focus(), [composerRef]);
  const { currentConversation, currentSessionRecordKey, currentComposerDraftKey, currentWorkspaceIdentity, connectorSessionIdentity, currentAgentId } = useChatStore(useShallow(selectChatSelection));
  const currentSessionConversation = currentConversation?.kind === 'session' ? currentConversation : null;
  const currentConversationEndpoint = currentConversation?.endpoint ?? null;
  const facts = useChatStore(useShallow(selectChatComposerFacts));
  const currentSession = {
    meta: { sessionIdentity: facts.sessionIdentity, endpointSessionId: facts.endpointSessionId,
      ownership: facts.ownership, goal: facts.goal, modelState: facts.modelState, historyStatus: facts.historyStatus },
    contextTokens: facts.contextTokens,
    runtime: { runPhase: facts.runPhase, activeRunId: facts.activeRunId, imageGeneration: { active: facts.imageGenerationActive } },
  };
  const connectorEndpointSessionId = currentSession.meta.endpointSessionId;
  const { runtime: currentConversationRuntime, directory: runtimeEndpointDirectory } = useChatRuntime();
  const currentChatRuntimeAvailable = currentConversationRuntime.state === 'ready';
  const currentRuntimeReconnecting = currentConversationRuntime.state === 'starting';
  const chatSideEffectsActive = isActive && currentChatRuntimeAvailable;
  const { agents, currentAgent } = useChatAgent();
  const providerModels = useSubagentsStore((state) => state.availableModels);
  const providerSnapshot = useProviderStore((state) => state.providerSnapshot);
  const providerModelsLoading = useSubagentsStore((state) => state.modelsLoading);
  const loadAvailableModels = useSubagentsStore((state) => state.loadAvailableModels);
  const currentSendGate = useChatStore(selectCurrentChatSendGate);
  const approvalStatus = useChatStore((state) => currentSessionRecordKey ? getSessionApprovalStatus(state, currentSessionRecordKey) : 'idle');
  const sessionSendPending = useChatStore((state) => hasPendingSessionSend(selectChatSession(state)));
  const thinkingSendPending = useChatStore((state) => {
    const record = selectChatSession(state);
    const send = currentSessionSend(record);
    return send?.receipt.phase === 'awaiting-receipt' || send?.receipt.phase === 'unknown';
  });
  const sendMessage = useChatStore((state) => state.sendMessage);
  const abortRun = useChatStore((state) => state.abortRun);
  const loadSessions = useChatStore((state) => state.loadSessions);
  const composerConfiguration = useComposerDraftStore((state) => currentComposerDraftKey ? state.configurations[currentComposerDraftKey] : undefined);
  const composerInitialization = useComposerDraftStore((state) => currentComposerDraftKey ? state.initializations[currentComposerDraftKey] : undefined);
  const setModelSelection = useComposerDraftStore((state) => state.setModelSelection);
  const setPermissionSelection = useComposerDraftStore((state) => state.setPermissionSelection);
  const setThinkingSelection = useComposerDraftStore((state) => state.setThinkingSelection);
  const gatewayStatus = useGatewayStore((state) => state.status);
  const isGatewayRunning = isGatewayOperational(gatewayStatus);
  const [skillPreview, setSkillPreview] = useState<ChatSkillPreviewState | null>(null);
  const skillPreviewRequestSeqRef = useRef(0);
  const isOpenClawModelSession = currentConversationEndpoint?.kind === 'native-runtime' && currentConversationEndpoint.runtimeAdapterId === 'openclaw';
  const isMatchaModelSession = currentConversationEndpoint?.kind === 'native-runtime' && currentConversationEndpoint.runtimeAdapterId === 'matcha-agent';
  const currentConfigurationScope = useMemo(() => currentConversationEndpoint && currentAgentId
    ? agentScope(currentConversationEndpoint, currentAgentId) : null, [currentAgentId, currentConversationEndpoint]);
  const currentSkillsScope = useMemo(() => isOpenClawModelSession && currentConversationEndpoint
    ? runtimeInstanceScope(currentConversationEndpoint) : isMatchaModelSession ? currentConfigurationScope : null,
  [currentConfigurationScope, currentConversationEndpoint, isMatchaModelSession, isOpenClawModelSession]);
  const imageGenerationActive = currentSession.runtime.imageGeneration?.active === true;
  const usesHostModelCandidates = isOpenClawModelSession || isMatchaModelSession;
  const availableModels = usesHostModelCandidates ? providerModels : EMPTY_AGENTS;
  const modelsLoading = usesHostModelCandidates && providerModelsLoading;
  const currentDraftScope = currentConversation?.kind === 'draft' ? currentConfigurationScope : null;
  const draftAgentModel = currentDraftScope ? agents.find((agent) => agent.id === currentAgentId)?.model ?? null : null;
  const draftModelEntry = useMemo(() => resolveModelCatalogEntry(availableModels, draftAgentModel),
    [availableModels, draftAgentModel]);
  const draftConfigurationScopeKey = currentDraftScope ? buildCapabilityScopeKey(currentDraftScope) : '';
  const draftConfigurationOwner = useMemo(() => ({ scope: currentDraftScope, ready: currentChatRuntimeAvailable, scopeKey: draftConfigurationScopeKey }), [currentDraftScope, currentChatRuntimeAvailable, draftConfigurationScopeKey]);
  const [draftConfigurationCapability, setDraftConfigurationCapability] = useState<{
    owner: typeof draftConfigurationOwner; permission: boolean; modelSelection: boolean;
  } | null>(null);
  const draftConfigurationReady = currentChatRuntimeAvailable && Boolean(currentDraftScope)
    && draftConfigurationCapability?.owner === draftConfigurationOwner;
  const composerInitializationBusy = composerInitialization?.kind === 'creating' || composerInitialization?.kind === 'createUnknown'
    || composerInitialization?.kind === 'pending' && !composerInitialization.outcome;
  const ownership = currentWorkspaceIdentity && currentSession.meta.sessionIdentity
    && sessionIdentitiesEqual(currentWorkspaceIdentity, currentSession.meta.sessionIdentity)
    ? currentSession.meta.ownership : null;
  const goalSupported = supportsSessionGoal(runtimeEndpointDirectory.endpoints, currentConversationEndpoint, currentAgentId ?? '');
  const chatGoals = useChatGoals(currentWorkspaceIdentity, currentSessionRecordKey, currentSession.meta.endpointSessionId, currentComposerDraftKey, goalSupported && chatSideEffectsActive, currentSession.meta.goal);
  const { begin: beginGoal, submit: submitGoal, act: actGoal, refresh: refreshGoalState } = chatGoals;
  const editingGoalId = chatGoals.mode?.goalId;
  const beginTypedGoal = useCallback((goalId?: string, objective?: string) => {
    if (beginGoal(goalId, objective)) composerRef.current?.focus();
  }, [beginGoal, composerRef]);
  const submitTypedGoal = useCallback((text: string, attachments?: Parameters<typeof sendMessage>[1]) => {
    if (!editingGoalId) viewportPaneRef.current?.prepareCurrentLatestBottomAlign();
    return submitGoal(text, attachments);
  }, [editingGoalId, submitGoal, viewportPaneRef]);
  const {
    selectedSkillIds,
    allowedSkillIdsForChat,
    availableSkillOptions,
    skillsLoading: skillConfigSkillsLoading,
    savingSkillId,
    prepare: prepareSkillConfig,
    resetSession: resetSkillConfigSession,
    toggleSkill: toggleSkillConfigSelection,
  } = useAgentSkillConfig({
    currentAgentId,
    scope: useChatStore(selectRuntimeAgentScope),
  });

  useEffect(() => {
    resetSkillConfigSession();
    skillPreviewRequestSeqRef.current += 1;
    setSkillPreview(null);
  }, [currentAgentId, resetSkillConfigSession]);

  useEffect(() => {
    if (!currentChatRuntimeAvailable || !usesHostModelCandidates) {
      return;
    }
    void loadAvailableModels();
  }, [currentChatRuntimeAvailable, loadAvailableModels, usesHostModelCandidates]);

  useEffect(() => {
    setDraftConfigurationCapability(null);
    if (!currentChatRuntimeAvailable || !currentDraftScope) return;
    let cancelled = false;
    void hostCapabilityDescribe({ id: 'session.prompt', scope: currentDraftScope })
      .then(({ capability }) => {
        if (cancelled) return;
        const available = capability.availability === 'available'
          && capability.operations.some((operation) => operation.id === 'sessions.create');
        setDraftConfigurationCapability({
          owner: draftConfigurationOwner,
          permission: available && capability.sessionConfiguration?.permission === true,
          modelSelection: available && capability.sessionConfiguration?.modelSelection === true,
        });
      })
      .catch(() => {
        if (!cancelled) setDraftConfigurationCapability({ owner: draftConfigurationOwner, permission: false, modelSelection: false });
      });
    return () => { cancelled = true; };
  }, [currentChatRuntimeAvailable, currentDraftScope, draftConfigurationOwner]);

  const modelSelectionIdentityKey = currentSessionConversation && currentWorkspaceIdentity
    ? buildSessionIdentityKey(currentWorkspaceIdentity) : '';
  const modelSelectionSupported = Boolean(usesHostModelCandidates && currentChatRuntimeAvailable && modelSelectionIdentityKey
    && currentWorkspaceIdentity && runtimeEndpointDirectory.endpoints.some((entry) => {
      if (!runtimeEndpointsEqual(entry.endpointRef, currentWorkspaceIdentity.endpoint) || !entry.capabilities.modelSelection) return false;
      const agent = entry.agents.find((agent) => agent.agentId === currentWorkspaceIdentity.agentId);
      return agent ? agent.capabilities.modelSelection : entry.acceptsDynamicAgents;
    }));
  const modelSelectionOwner = useMemo(() => ({ conversation: currentSessionConversation, identityKey: modelSelectionIdentityKey, supported: modelSelectionSupported }), [currentSessionConversation, modelSelectionIdentityKey, modelSelectionSupported]);
  const [modelSelectionCapabilityOwner, setModelSelectionCapabilityOwner] = useState<typeof modelSelectionOwner | null>(null);
  const modelSelectionAvailable = modelSelectionSupported && modelSelectionCapabilityOwner === modelSelectionOwner;
  const modelSelectionOperationRef = useRef<{ owner: typeof modelSelectionOwner } | null>(null);
  const [modelSelectionOperation, setModelSelectionOperation] = useState<{ owner: typeof modelSelectionOwner } | null>(null);
  const modelSwitching = modelSelectionOperation?.owner === modelSelectionOwner;
  const currentModelSelectionOwnerRef = useRef<typeof modelSelectionOwner | null>(null);
  useLayoutEffect(() => {
    currentModelSelectionOwnerRef.current = modelSelectionOwner;
    return () => { currentModelSelectionOwnerRef.current = null; };
  }, [modelSelectionOwner]);
  useEffect(() => {
    setModelSelectionCapabilityOwner(null);
    if (!modelSelectionSupported || !currentWorkspaceIdentity) return;
    let cancelled = false;
    void hostCapabilityDescribe({ id: 'session.modelSelection', scope: sessionScope(currentWorkspaceIdentity) })
      .then(({ capability }) => {
        if (!cancelled && capability.availability === 'available'
          && capability.operations.some((operation) => operation.id === 'sessions.patchModel')) {
          setModelSelectionCapabilityOwner(modelSelectionOwner);
        }
      })
      .catch(() => { if (!cancelled) setModelSelectionCapabilityOwner(null); });
    return () => { cancelled = true; };
  }, [currentWorkspaceIdentity, modelSelectionOwner, modelSelectionSupported, runtimeEndpointDirectory.endpoints]);

  useEffect(() => {
    if (!chatSideEffectsActive) {
      return;
    }
    prepareSkillConfig();
  }, [prepareSkillConfig, chatSideEffectsActive]);
  const currentSessionModelReference = currentSession.meta.modelState?.selectionId
    ?? currentSession.meta.modelState?.selected?.ref
    ?? '';
  const currentSessionModelEntry = useMemo(() => {
    return isOpenClawModelSession
      ? resolveModelCatalogEntry(availableModels, currentSessionModelReference)
      : availableModels.find((model) => model.id === currentSession.meta.modelState?.selectionId);
  }, [availableModels, currentSession.meta.modelState?.selectionId, currentSessionModelReference, isOpenClawModelSession]);
  const currentSessionModelId = isMatchaModelSession
    ? currentSession.meta.modelState?.selectionId ?? ''
    : currentSessionModelEntry?.id ?? currentSessionModelReference;
  const contextUsage = useMemo(() => buildChatContextUsageViewModel({
    snapshot: currentSession.contextTokens,
    currentModelId: currentSessionModelId,
    availableModels: isOpenClawModelSession ? availableModels : EMPTY_AGENTS,
  }), [availableModels, currentSession.contextTokens, currentSessionModelId, isOpenClawModelSession]);
  const activeRun = isRunActive(currentSession.runtime)
    || currentSession.runtime.activeRunId != null;
  const handlePermissionIntent = useCallback<Parameters<typeof useChatPermissions>[0]['onSelectIntent']>((selection) => {
    setPermissionSelection(currentComposerDraftKey, selection);
  }, [currentComposerDraftKey, setPermissionSelection]);
  const permissionPicker = useChatPermissions({
    scope: currentConfigurationScope,
    identity: currentSessionConversation?.sessionIdentity ?? null,
    ready: currentChatRuntimeAvailable,
    activeRun,
    draft: currentConversation?.kind === 'draft',
    draftAvailable: draftConfigurationReady && draftConfigurationCapability?.permission === true,
    draftLoading: Boolean(currentDraftScope) && currentChatRuntimeAvailable && !draftConfigurationReady,
    initializationBusy: composerInitializationBusy || sessionSendPending,
    pendingSelection: composerConfiguration?.permissionSelection,
    pendingConfiguration: composerInitialization?.kind === 'pending',
    onSelectIntent: handlePermissionIntent,
  });
  const handleThinkingIntent = useCallback<Parameters<typeof useChatThinking>[0]['onSelectIntent']>((selection) => {
    setThinkingSelection(currentComposerDraftKey, selection);
  }, [currentComposerDraftKey, setThinkingSelection]);
  const thinkingPicker = useChatThinking({
    conversation: currentConversation,
    scope: currentConfigurationScope,
    identity: currentSessionConversation?.sessionIdentity ?? null,
    recordKey: currentSessionRecordKey,
    ready: currentChatRuntimeAvailable,
    activeRun,
    modelSelectionId: composerConfiguration?.modelSelectionId,
    modelReference: currentDraftScope ? draftAgentModel ?? '' : currentSessionModelReference,
    modelSwitching,
    initializationBusy: composerInitializationBusy || thinkingSendPending || currentSession.runtime.runPhase === 'stopping',
    pendingConfiguration: composerInitialization?.kind === 'pending',
    pendingSelection: composerConfiguration?.thinkingSelection,
    onSelectIntent: handleThinkingIntent,
  });
  const modelOptions = useMemo(() => availableModels.map((model) => {
    const report = model.accountId && currentConversationEndpoint?.kind === 'native-runtime'
      ? getProviderAccountRuntimeReport(providerSnapshot, model.accountId, currentConversationEndpoint) : undefined;
    const execution = report?.execution ?? 'unknown';
    const disabled = execution === 'blocked' || execution === 'unsupported';
    const description = disabled
      ? providerDiagnosticError(report?.diagnostic ?? null) ?? t(execution === 'unsupported' ? 'input.modelAccountUnsupported' : 'input.modelAccountBlocked')
      : undefined;
    return { id: model.id, label: model.modelLabel, provider: model.providerLabel, groupId: model.accountId, disabled, description };
  }), [availableModels, currentConversationEndpoint, providerSnapshot, t]);
  const selectedModelOption = modelOptions.find((option) => option.id === (composerConfiguration?.modelSelectionId
    ?? (currentDraftScope ? draftModelEntry?.id : currentSessionModelId)));
  const modelAccountNotice = selectedModelOption?.disabled ? selectedModelOption.description : null;
  const modelPicker = useMemo(() => {
    const intendedModelId = composerConfiguration?.modelSelectionId;
    const currentModelId = intendedModelId ?? (currentDraftScope ? '' : currentSessionModelId);
    if (!thinkingPicker && !currentModelId && !draftAgentModel && availableModels.length === 0 && !modelsLoading
      && !(isMatchaModelSession && (currentSession.meta.modelState?.selected || currentSession.meta.modelState?.active))) {
      return null;
    }
    const triggerLabels = new Map<string, string>();
    for (const model of availableModels) {
      triggerLabels.set(model.id, model.modelLabel);
    }
    const defaultModelLabel = draftModelEntry?.modelLabel ?? draftAgentModel;
    const selectedLabel = currentModelId
      ? triggerLabels.get(currentModelId) ?? (currentModelId === currentSessionModelId ? currentSession.meta.modelState?.selected?.model : null) ?? currentModelId
      : (currentDraftScope ? defaultModelLabel : currentSession.meta.modelState?.selected?.model) ?? t('input.pickModel');
    return {
      currentModelId,
      currentLabel: selectedLabel,
      options: modelOptions,
      loading: modelsLoading,
      switching: modelSwitching,
      disabled: activeRun || sessionSendPending || !currentChatRuntimeAvailable || composerInitializationBusy && !thinkingPicker?.switching || (currentDraftScope
        ? !draftConfigurationReady || draftConfigurationCapability?.modelSelection !== true : !modelSelectionAvailable),
    };
  }, [activeRun, availableModels, composerConfiguration?.modelSelectionId, composerInitializationBusy, currentChatRuntimeAvailable, currentDraftScope, currentSession.meta.modelState, currentSessionModelId, draftAgentModel, draftModelEntry, draftConfigurationCapability, draftConfigurationReady, isMatchaModelSession, modelOptions, modelSelectionAvailable, modelSwitching, modelsLoading, sessionSendPending, t, thinkingPicker]);
  const composerContextTraceRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isSessionTraceEnabled()) return;
    const modelState = currentSession.meta.modelState;
    const context = {
      identity: summarizeSessionIdentity(connectorSessionIdentity), recordKey: summarizeIdentifier(currentSessionRecordKey),
      endpointSessionId: summarizeIdentifier(connectorEndpointSessionId),
      conversationKind: currentConversation?.kind ?? null, runtimeState: currentConversationRuntime.state,
      directoryStatus: runtimeEndpointDirectory.status, gatewayRunning: isGatewayRunning,
      composerDisabled: !currentChatRuntimeAvailable,
      historyStatus: currentSession.meta.historyStatus, runPhase: currentSession.runtime.runPhase,
      activeRun: summarizeIdentifier(currentSession.runtime.activeRunId), modelBlockedByRun: activeRun,
      modelState: {
        present: !!modelState, selectionId: summarizeIdentifier(modelState?.selectionId),
        selectedRef: summarizeIdentifier(modelState?.selected?.ref), activeRef: summarizeIdentifier(modelState?.active?.ref),
        overrideSource: modelState?.overrideSource ?? null,
      },
      displayedModel: summarizeIdentifier(currentSessionModelId), catalogMatch: !!currentSessionModelEntry,
      availableModelCount: availableModels.length, modelsLoading,
    };
    const signature = JSON.stringify(context);
    if (composerContextTraceRef.current === signature) return;
    composerContextTraceRef.current = signature;
    logSessionTrace('session.composer.context', 'session-composer-boundary', () => context);
  });
  const handleSendMessage = useCallback(async (
    text: string,
    attachments?: Parameters<typeof sendMessage>[1],
    operationId?: string,
  ) => {
    viewportPaneRef.current?.prepareCurrentLatestBottomAlign();
    return sendMessage(text, attachments, undefined, operationId);
  }, [sendMessage, viewportPaneRef]);
  const handleSelectModel = useCallback(async (modelSelectionId: string) => {
    const traceId = createSessionTraceId('model-selection');
    const normalizedModelSelectionId = modelSelectionId.trim();
    const currentModelSelectionId = currentSessionModelId;
    logSessionTrace('model-selection.enter', traceId, () => ({
      currentSessionKey: summarizeIdentifier(currentSessionRecordKey),
      requestedModelSelectionId: summarizeIdentifier(normalizedModelSelectionId),
      currentModelSelectionId: summarizeIdentifier(currentModelSelectionId),
      activeRun: Boolean(activeRun),
    }));
    if (!normalizedModelSelectionId || !modelPicker || modelPicker.disabled || modelPicker.loading || modelPicker.switching || thinkingPicker?.switching
      || !modelPicker.options.some((model) => model.id === normalizedModelSelectionId && !model.disabled)) return;
    if (currentConversation?.kind === 'draft' || composerInitialization?.kind === 'pending') {
      setModelSelection(currentComposerDraftKey, normalizedModelSelectionId);
      return;
    }
    if (!currentSessionRecordKey || !currentSessionConversation || normalizedModelSelectionId === currentModelSelectionId) return;
    const conversation = currentSessionConversation;
    if (currentModelSelectionOwnerRef.current !== modelSelectionOwner
      || modelSelectionOperationRef.current?.owner === modelSelectionOwner
      || useChatStore.getState().currentConversation !== conversation) return;
    const operation = { owner: modelSelectionOwner };
    modelSelectionOperationRef.current = operation;
    setModelSelectionOperation(operation);
    const isCurrent = () => currentModelSelectionOwnerRef.current === modelSelectionOwner
      && modelSelectionOperationRef.current === operation
      && useChatStore.getState().currentConversation === conversation;
    try {
      const result = await useChatStore.getState().selectSessionModel(currentSessionRecordKey, normalizedModelSelectionId);
      logSessionTrace('model-selection.result', traceId, () => ({ outcome: result.outcome }));
      if (result.outcome !== 'succeeded') throw new Error(result.outcome);
      if (isCurrent()) void loadSessions();
    } catch (error) {
      logSessionTrace('model-selection.error', traceId, () => summarizeError(error));
      if (isCurrent()) toast.error(t('input.modelSwitchFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (modelSelectionOperationRef.current === operation) modelSelectionOperationRef.current = null;
      setModelSelectionOperation((current) => current === operation ? null : current);
    }
  }, [activeRun, composerInitialization?.kind, currentComposerDraftKey, currentConversation?.kind, currentSessionConversation, currentSessionModelId, currentSessionRecordKey, loadSessions, modelPicker, modelSelectionOwner, setModelSelection, t, thinkingPicker?.switching]);
  const handlePreviewSkill = useCallback(async (skill: {
    id: string;
    name: string;
    slug?: string;
    filePath?: string;
    baseDir?: string;
  }) => {
    const requestSeq = skillPreviewRequestSeqRef.current + 1;
    skillPreviewRequestSeqRef.current = requestSeq;
    setSkillPreview({
      skillId: skill.id,
      skillName: skill.name,
      markdown: null,
      loading: true,
      error: null,
      filePath: skill.filePath,
    });
    try {
      const result = await hostApiFetch<{
        success: boolean;
        content?: string;
        error?: string;
        filePath?: string;
      }>('/api/skills/readme', {
        method: 'POST',
        body: JSON.stringify({
          skillKey: skill.id,
          slug: skill.slug,
          filePath: skill.filePath,
          baseDir: skill.baseDir,
        }),
      });
      if (skillPreviewRequestSeqRef.current !== requestSeq) {
        return;
      }
      if (!result.success || typeof result.content !== 'string') {
        throw new Error(result.error || t('skillPreviewNotFound'));
      }
      setSkillPreview({
        skillId: skill.id,
        skillName: skill.name,
        markdown: result.content,
        loading: false,
        error: null,
        filePath: result.filePath || skill.filePath,
      });
    } catch (error) {
      if (skillPreviewRequestSeqRef.current !== requestSeq) {
        return;
      }
      setSkillPreview({
        skillId: skill.id,
        skillName: skill.name,
        markdown: null,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        filePath: skill.filePath,
      });
    }
  }, [t]);
  const refreshGoal = useCallback(() => { void refreshGoalState(); }, [refreshGoalState]);
  const startGoal = useCallback(() => beginTypedGoal(), [beginTypedGoal]);
  const goal = useMemo(() => ({
    supported: goalSupported,
    mode: chatGoals.mode,
    busy: chatGoals.busy,
    unknown: chatGoals.unknown,
    canDiscard: chatGoals.canDiscard ?? false,
    error: chatGoals.error,
    onRefresh: refreshGoal,
    onStart: startGoal,
    onCancel: chatGoals.cancel,
    onSubmit: submitTypedGoal,
  }), [chatGoals.busy, chatGoals.canDiscard, chatGoals.cancel, chatGoals.error, chatGoals.mode, chatGoals.unknown, goalSupported, refreshGoal, startGoal, submitTypedGoal]);
  const sessionGoal = currentSession.meta.goal;
  const editGoal = useCallback(() => {
    if (sessionGoal.kind === 'known' && sessionGoal.goal) beginTypedGoal(sessionGoal.goal.id, sessionGoal.goal.objective);
  }, [beginTypedGoal, sessionGoal]);
  const actOnGoal = useCallback<Parameters<typeof ChatGoalDock>[0]['onAction']>((update) => {
    if (sessionGoal.kind === 'known' && sessionGoal.goal) void actGoal(sessionGoal.goal.id, update);
  }, [actGoal, sessionGoal]);
  const dockGoal = chatGoals.dock?.goal;
  const goalDockVisible = goalSupported && !!chatGoals.dock;
  const goalDockDisabled = !chatSideEffectsActive || chatGoals.unknown || Boolean(chatGoals.mode);
  const goalDock = useMemo(() => goalDockVisible ? <ChatGoalDock
    key={currentComposerDraftKey}
    goal={dockGoal ?? null}
    busy={chatGoals.busy}
    runActive={activeRun}
    disabled={goalDockDisabled}
    error={chatGoals.error}
    onEdit={editGoal}
    onAction={actOnGoal}
    onRefresh={refreshGoal}
  /> : null, [actOnGoal, activeRun, chatGoals.busy, chatGoals.error, currentComposerDraftKey, dockGoal, editGoal, goalDockDisabled, goalDockVisible, refreshGoal]);
  const clearSkillPreview = useCallback(() => setSkillPreview(null), []);
  const skillManager = useMemo(() => ({
    label: t('toolbar.skillConfig'),
    title: t('skillConfigDialog.titleWithAgent', { agent: currentAgent?.name || currentAgentId }),
    options: availableSkillOptions,
    loading: skillConfigSkillsLoading,
    savingSkillId,
    selectedSkillIds,
    skillPreview,
    onToggleSkill: toggleSkillConfigSelection,
    onPreviewSkill: handlePreviewSkill,
    onClearSkillPreview: clearSkillPreview,
  }), [availableSkillOptions, clearSkillPreview, currentAgent?.name, currentAgentId, handlePreviewSkill, savingSkillId, selectedSkillIds, skillConfigSkillsLoading, skillPreview, t, toggleSkillConfigSelection]);
  const inputModelPicker = useMemo(() => modelPicker ? {
    ...modelPicker,
    thinking: thinkingPicker,
    onSelect: (modelSelectionId: string) => { void handleSelectModel(modelSelectionId); },
  } : null, [handleSelectModel, modelPicker, thinkingPicker]);
  return <ChatComposerContributions
    sessionIdentity={currentWorkspaceIdentity}
    ownership={ownership}
    enabled={chatSideEffectsActive}
    runActive={isRunActive(currentSession.runtime)}
    imageGenerationActive={imageGenerationActive}
    approvalWaiting={approvalStatus === 'awaiting_approval'}
    canSend={currentSendGate.canSend}
    focusComposer={focusComposer}
  >
    {(composerContent) => children((topContent) => <ChatInput
      ref={composerRef}
      topContent={<>
        {topContent}
        {modelAccountNotice ? <p role="status" className={CHAT_LAYOUT_TOKENS.inputBannerItem}>{modelAccountNotice}</p> : null}
      </>}
      draftKey={currentComposerDraftKey}
      onSend={handleSendMessage}
      goal={goal}
      goalDock={goalDock}
      onStop={abortRun}
      skillsScope={currentSkillsScope}
      skillManager={skillManager}
      modelPicker={inputModelPicker}
      permissionPicker={permissionPicker}
      contextUsage={contextUsage}
      composerContent={composerContent}
      disabled={!currentChatRuntimeAvailable}
      reconnecting={currentRuntimeReconnecting}
      sending={isRunActive(currentSession.runtime)}
      imageGenerationActive={imageGenerationActive}
      sendGate={currentSendGate}
      stopping={currentSession.runtime.runPhase === 'stopping'}
      approvalWaiting={approvalStatus === 'awaiting_approval'}
      allowedSkillIds={allowedSkillIdsForChat}
      sessionIdentity={connectorSessionIdentity}
      endpointSessionId={connectorEndpointSessionId}
      activeRunId={currentSession.runtime.activeRunId}
      runPhase={currentSession.runtime.runPhase}
    />)}
  </ChatComposerContributions>;
});
