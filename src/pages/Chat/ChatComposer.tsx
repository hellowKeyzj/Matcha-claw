import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { ArrowUpRight, GitBranch, Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/stores/chat';
import { selectCurrentChatSendGate, selectRuntimeAgentScope } from '@/stores/chat/selectors';
import { hasPendingSessionSend } from '@/stores/chat/session-presentation';
import { isRunActive } from '@/stores/chat/types';
import { isRuntimeEndpointReady, supportsSessionGoal, supportsRuntimeEndpointCapabilityFamily } from '@/stores/runtime-endpoints';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { resolveTeamRuntimeScope, useTeamsStore } from '@/stores/teams';
import type { TeamDesignTarget } from '@/types/team-design';
import { useComposerDraftStore } from '@/stores/composer-drafts';
import { agentScope, buildCapabilityScopeKey, buildSessionIdentityKey, runtimeEndpointsEqual, runtimeInstanceScope, sessionIdentitiesEqual, sessionScope } from '@/types/desktop/runtime-address';
import { getSessionApprovalStatus } from '@/stores/chat/store-state-helpers';
import { ChatInput, type ChatInputHandle } from './ChatInput';
import type { ChatListHandle } from './components/ChatList';
import { useAgentSkillConfig } from './useAgentSkillConfig';
import { useChatGoals } from './useChatGoals';
import { useChatPermissions } from './useChatPermissions';
import { ChatGoalDock } from './ChatGoalDock';
import { hostApiFetch, hostCapabilityDescribe } from '@/lib/host-api';
import { toast } from 'sonner';
import { createSessionTraceId, logSessionTrace, summarizeError, summarizeIdentifier, summarizeSessionIdentity, isSessionTraceEnabled } from '@/lib/session-trace';
import { buildChatContextUsageViewModel } from './context-usage';
import { resolveModelCatalogEntry } from '@/lib/provider-models';
import { isGatewayOperational } from '@/lib/gateway-status';
import { openChatRuntimeSurface } from './useChatSidePanelController';
import { selectChatComposerFacts, selectChatSelection, selectChatSession, useChatAgent, useChatRuntime } from './chat-session';

type ChatSkillPreviewState = {
  skillId: string;
  skillName: string;
  markdown: string | null;
  loading: boolean;
  error: string | null;
  filePath?: string;
};
const EMPTY_AGENTS: never[] = [];
function resolveModelTriggerLabel(modelId: string): string {
  const separatorIndex = modelId.indexOf('/');
  if (separatorIndex < 0 || separatorIndex === modelId.length - 1) {
    return modelId;
  }
  return modelId.slice(separatorIndex + 1);
}

export const ChatComposer = memo(function ChatComposer({ isActive, composerRef, viewportPaneRef, children }: {
  isActive: boolean;
  composerRef: RefObject<ChatInputHandle | null>;
  viewportPaneRef: RefObject<ChatListHandle | null>;
  children: (input: ReactNode) => ReactNode;
}) {
  const { t } = useTranslation('chat');
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
  const providerModelsLoading = useSubagentsStore((state) => state.modelsLoading);
  const loadAvailableModels = useSubagentsStore((state) => state.loadAvailableModels);
  const currentSendGate = useChatStore(selectCurrentChatSendGate);
  const approvalStatus = useChatStore((state) => currentSessionRecordKey ? getSessionApprovalStatus(state, currentSessionRecordKey) : 'idle');
  const sessionSendPending = useChatStore((state) => hasPendingSessionSend(selectChatSession(state)));
  const sendMessage = useChatStore((state) => state.sendMessage);
  const abortRun = useChatStore((state) => state.abortRun);
  const loadSessions = useChatStore((state) => state.loadSessions);
  const composerConfiguration = useComposerDraftStore((state) => currentComposerDraftKey ? state.configurations[currentComposerDraftKey] : undefined);
  const composerInitialization = useComposerDraftStore((state) => currentComposerDraftKey ? state.initializations[currentComposerDraftKey] : undefined);
  const setModelSelection = useComposerDraftStore((state) => state.setModelSelection);
  const setPermissionSelection = useComposerDraftStore((state) => state.setPermissionSelection);
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
  const teamOwnership = currentWorkspaceIdentity && currentSession.meta.sessionIdentity
    && sessionIdentitiesEqual(currentWorkspaceIdentity, currentSession.meta.sessionIdentity)
    ? currentSession.meta.ownership : null;
  const teamGraphTeamId = teamOwnership?.kind === 'team' ? teamOwnership.teamId : null;
  const teamGraphRunId = teamOwnership?.kind === 'team' ? teamOwnership.teamRunId : null;
  const designTeamId = teamOwnership?.kind === 'team' && teamOwnership.roleId === 'leader' ? teamGraphTeamId : null;
  const designRunId = teamOwnership?.kind === 'team' && teamOwnership.roleId === 'leader' ? teamGraphRunId : null;
  const designTeamKnown = useTeamsStore((state) => Boolean(designTeamId && state.teams.some((team) => team.id === designTeamId)));
  const designRuntimeAvailable = designTeamKnown && designTeamId && designRunId
    ? runtimeEndpointDirectory.endpoints.some((entry) => {
        const scope = resolveTeamRuntimeScope(designTeamId, designRunId);
        return 'endpoint' in scope && runtimeEndpointsEqual(entry.endpointRef, scope.endpoint)
          && isRuntimeEndpointReady(entry) && supportsRuntimeEndpointCapabilityFamily(entry, 'team');
      }) : false;
  const designRecord = useTeamsStore((state) => designRunId ? state.designByRunId[designRunId] : undefined);
  const observeTeamDesign = useTeamsStore((state) => state.observeTeamDesign);
  const startDesign = useTeamsStore((state) => state.startDesign);
  const startRun = useTeamsStore((state) => state.startRun);
  const exitDesign = useTeamsStore((state) => state.exitDesign);
  const designActionPending = Boolean(designRecord?.mutationPending);
  const designSnapshot = designRecord?.snapshot && designRecord.snapshot.teamId === designTeamId && designRecord.snapshot.runId === designRunId ? designRecord.snapshot : null;
  const designContextKey = JSON.stringify([designTeamId, designRunId, currentWorkspaceIdentity ? buildSessionIdentityKey(currentWorkspaceIdentity) : null]);
  const [pendingDesignAction, setPendingDesignAction] = useState<{ contextKey: string; action: 'start' | 'exit' } | null>(null);
  const currentDesignContextRef = useRef(designContextKey);
  currentDesignContextRef.current = designContextKey;
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
  useEffect(() => {
    if (!chatSideEffectsActive || !designRuntimeAvailable || !designTeamKnown || !designTeamId || !designRunId) return;
    return observeTeamDesign({ teamId: designTeamId, runId: designRunId });
  }, [chatSideEffectsActive, designRuntimeAvailable, designTeamKnown, designTeamId, designRunId, observeTeamDesign]);
  const designActionDisabled = !designTeamKnown || !designSnapshot || designSnapshot.startGate.status === 'started'
    || Boolean(designRecord?.loading) || designActionPending || !designRuntimeAvailable || !chatSideEffectsActive
    || isRunActive(currentSession.runtime) || imageGenerationActive
    || approvalStatus === 'awaiting_approval' || !currentSendGate.canSend;
  const runDesignAction = useCallback(async (action: (target: TeamDesignTarget) => Promise<void>, focusComposer = false): Promise<void> => {
    if (!designTeamId || !designRunId || designActionDisabled) return;
    const contextKey = designContextKey;
    const pending: typeof pendingDesignAction = action === startRun ? { contextKey, action: 'start' }
      : action === exitDesign ? { contextKey, action: 'exit' } : null;
    if (pending) setPendingDesignAction(pending);
    try {
      await action({ teamId: designTeamId, runId: designRunId });
      if (currentDesignContextRef.current !== contextKey) return;
      if (action === startRun && currentWorkspaceIdentity) {
        openChatRuntimeSurface({ kind: 'team-graph', sourceSessionIdentity: currentWorkspaceIdentity, teamId: designTeamId, runId: designRunId });
      }
      if (focusComposer) composerRef.current?.focus();
    } catch (error) {
      if (currentDesignContextRef.current === contextKey) toast.error(t('teams:design.actionFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (pending) setPendingDesignAction((current) => current === pending ? null : current);
    }
  }, [composerRef, currentWorkspaceIdentity, designActionDisabled, designContextKey, designRunId, designTeamId, exitDesign, startRun, t]);
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
  const modelPicker = useMemo(() => {
    const intendedModelId = composerConfiguration?.modelSelectionId;
    const currentModelId = intendedModelId ?? (currentDraftScope ? '' : currentSessionModelId);
    if (!currentModelId && !draftAgentModel && availableModels.length === 0 && !modelsLoading
      && !(isMatchaModelSession && (currentSession.meta.modelState?.selected || currentSession.meta.modelState?.active))) {
      return null;
    }
    const triggerLabels = new Map<string, string>();
    for (const model of availableModels) {
      triggerLabels.set(model.id, model.modelLabel);
    }
    const options = availableModels.map((model) => ({
      id: model.id,
      label: model.displayLabel,
    }));
    const defaultModelLabel = draftModelEntry?.modelLabel ?? draftAgentModel;
    const selectedLabel = currentModelId
      ? triggerLabels.get(currentModelId) ?? resolveModelTriggerLabel(currentModelId)
      : (currentDraftScope ? defaultModelLabel : currentSession.meta.modelState?.selected?.model) ?? t('input.pickModel');
    return {
      currentModelId,
      currentLabel: selectedLabel,
      options,
      loading: modelsLoading,
      switching: modelSwitching,
      disabled: activeRun || sessionSendPending || modelSwitching || !currentChatRuntimeAvailable || composerInitializationBusy || (currentDraftScope
        ? !draftConfigurationReady || draftConfigurationCapability?.modelSelection !== true : !modelSelectionAvailable),
    };
  }, [activeRun, availableModels, composerConfiguration?.modelSelectionId, composerInitializationBusy, currentChatRuntimeAvailable, currentDraftScope, currentSession.meta.modelState, currentSessionModelId, draftAgentModel, draftModelEntry, draftConfigurationCapability, draftConfigurationReady, isMatchaModelSession, modelSelectionAvailable, modelSwitching, modelsLoading, sessionSendPending, t]);
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
  ) => {
    viewportPaneRef.current?.prepareCurrentLatestBottomAlign();
    return sendMessage(text, attachments);
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
    if (!normalizedModelSelectionId || !modelPicker || modelPicker.disabled || modelPicker.loading
      || !availableModels.some((model) => model.id === normalizedModelSelectionId)) return;
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
  }, [activeRun, availableModels, composerInitialization?.kind, currentComposerDraftKey, currentConversation?.kind, currentSessionConversation, currentSessionModelId, currentSessionRecordKey, loadSessions, modelPicker, modelSelectionOwner, setModelSelection, t]);
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
    onSelect: (modelSelectionId: string) => { void handleSelectModel(modelSelectionId); },
  } : null, [handleSelectModel, modelPicker]);
  const teamDesignStatus = designSnapshot?.startGate.status ?? null;
  const teamDesignStarting = designActionPending && pendingDesignAction?.contextKey === designContextKey && pendingDesignAction.action === 'start';
  const teamDesignExiting = designActionPending && pendingDesignAction?.contextKey === designContextKey && pendingDesignAction.action === 'exit';
  const teamDesignError = designRecord?.error ?? null;
  const teamDesignExitWaiting = isRunActive(currentSession.runtime) || approvalStatus === 'awaiting_approval' || !currentSendGate.canSend;
  const teamActions = useMemo(() => {
    if (!teamGraphTeamId || !teamGraphRunId || !currentWorkspaceIdentity) return null;
    const hasDesignActions = Boolean(designTeamId && designRunId);
    const canOpenTeamGraph = !hasDesignActions || teamDesignStatus === 'designing' || teamDesignStatus === 'started';
    const openTeamGraph = () => {
      openChatRuntimeSurface({ kind: 'team-graph', sourceSessionIdentity: currentWorkspaceIdentity, teamId: teamGraphTeamId, runId: teamGraphRunId });
    };
    return <>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 max-md:px-2.5 max-sm:px-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 rounded-md px-2 text-foreground"
          disabled={!canOpenTeamGraph && designActionDisabled}
          onClick={canOpenTeamGraph ? openTeamGraph : () => {
            openTeamGraph();
            void runDesignAction(startDesign, true);
          }}
        >
          <GitBranch aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span role={teamDesignStatus === 'designing' ? 'status' : undefined} className="truncate">{t(!hasDesignActions || teamDesignStatus === 'started' ? 'input.teamRunGraphView' : teamDesignStatus === 'designing' ? 'input.teamDesignInProgress' : 'input.teamDesignStart')}</span>
          {canOpenTeamGraph ? <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : null}
        </Button>
        {hasDesignActions && teamDesignStatus !== 'started' ? (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {teamDesignStatus === 'designing' ? (
              <span title={t(teamDesignExitWaiting ? 'input.teamDesignExitWaiting' : 'input.teamDesignExit')}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-md px-2.5 text-foreground"
                  disabled={designActionDisabled}
                  onClick={() => { void runDesignAction(exitDesign, true); }}
                  aria-busy={teamDesignExiting}
                >
                  {teamDesignExiting ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : null}
                  {t(teamDesignExiting ? 'input.teamDesignExiting' : 'teams:design.discuss')}
                </Button>
              </span>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 rounded-md px-3"
              disabled={designActionDisabled}
              onClick={() => { void runDesignAction(startRun); }}
              aria-busy={teamDesignStarting}
            >
              {teamDesignStarting
                ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                : <Play aria-hidden="true" className="h-3.5 w-3.5" />}
              {t(teamDesignStarting ? 'teams:design.starting' : 'teams:design.run')}
            </Button>
          </div>
        ) : null}
      </div>
      {hasDesignActions && teamDesignError ? <p role="alert" className="mb-2 text-xs text-destructive">{teamDesignError}</p> : null}
    </>;
  }, [currentWorkspaceIdentity, designActionDisabled, designRunId, designTeamId, exitDesign, runDesignAction, startDesign, startRun, t, teamDesignError, teamDesignExitWaiting, teamDesignExiting, teamDesignStarting, teamDesignStatus, teamGraphRunId, teamGraphTeamId]);
  return children(
    <ChatInput
      ref={composerRef}
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
      teamActions={teamActions}
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
    />
  );
});
