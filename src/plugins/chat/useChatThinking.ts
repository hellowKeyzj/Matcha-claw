import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hostCapabilityDescribe, hostSessionThinkingGet } from '@/lib/host-api';
import { createSessionTraceId, logSessionTrace, summarizeError, summarizeIdentifier } from '@/lib/session-trace';
import { useChatStore } from '@/plugins/chat/store';
import { executeSessionThinkingSelection } from '@/plugins/chat/store/session-initialization';
import type { ChatCurrentConversation } from '@/plugins/chat/store/types';
import type { ComposerThinkingSelection } from '@/plugins/chat/composer-drafts';
import { buildCapabilityScopeKey, sessionScope, type AgentScope, type SessionIdentity } from '@/types/desktop/runtime-address';
import type { SessionThinkingResult } from '@/types/session-thinking';
import type { ThinkingPickerState } from '@/plugins/chat/components/ChatModelPicker';

export function useChatThinking({
  conversation, scope, identity, recordKey, ready, activeRun, modelSelectionId, modelReference, modelSwitching,
  initializationBusy, pendingConfiguration, pendingSelection, onSelectIntent,
}: {
  conversation: ChatCurrentConversation | null;
  scope: AgentScope | null;
  identity: SessionIdentity | null;
  recordKey: string;
  ready: boolean;
  activeRun: boolean;
  modelSelectionId: string | undefined;
  modelReference: string;
  modelSwitching: boolean;
  initializationBusy: boolean;
  pendingConfiguration: boolean;
  pendingSelection: ComposerThinkingSelection | undefined;
  onSelectIntent: (selection: ComposerThinkingSelection) => void;
}): ThinkingPickerState | null {
  const { t } = useTranslation('chat');
  const draft = conversation?.kind === 'draft';
  const target = useMemo(() => identity ? sessionScope(identity) : scope, [identity, scope]);
  const endpoint = identity?.endpoint ?? scope?.endpoint;
  const runtime = endpoint?.kind === 'native-runtime' && endpoint.runtimeInstanceId === 'local'
    && (endpoint.runtimeAdapterId === 'openclaw' || endpoint.runtimeAdapterId === 'matcha-agent') ? endpoint.runtimeAdapterId : null;
  const scopeKey = target ? buildCapabilityScopeKey(target) : '';
  const modelHint = draft || pendingConfiguration ? modelSelectionId : undefined;
  const modelKey = JSON.stringify([modelReference, modelHint]);
  const preview = draft || modelHint !== undefined;
  const owner = useMemo(() => ({ recordKey, scopeKey, draft }), [draft, recordKey, scopeKey]);
  const request = useMemo(() => ({ owner, conversation, identity, modelKey, ready, modelSwitching, preview }), [conversation, identity, modelKey, modelSwitching, owner, preview, ready]);
  const operationRef = useRef<{ request: typeof request; sequence: number; switching: boolean } | null>(null);
  const [state, setState] = useState<{
    request: typeof request; result: SessionThinkingResult | null; switching: boolean; writeResult?: SessionThinkingResult;
  }>({ request, result: null, switching: false });

  useLayoutEffect(() => {
    operationRef.current = { request, sequence: 0, switching: false };
    return () => { operationRef.current = null; };
  }, [request]);

  useEffect(() => {
    const operation = operationRef.current;
    if (!ready || !target || !runtime || modelSwitching || operation?.request !== request || operation.switching) return;
    const traceId = createSessionTraceId('thinking-read');
    const sequence = ++operation.sequence;
    let cancelled = false;
    const isCurrent = () => !cancelled && operationRef.current === operation && operation.sequence === sequence;
    logSessionTrace('thinking.read.start', traceId, () => ({
      owner: summarizeIdentifier(scopeKey), model: summarizeIdentifier(modelKey), preview,
    }));
    void hostCapabilityDescribe({ id: 'session.thinking', scope: target }, { traceId })
      .then(async ({ capability }) => {
        logSessionTrace('thinking.describe.result', traceId, () => ({
          availability: capability.availability, stale: !isCurrent(),
        }));
        if (!isCurrent()) return;
        const supported = capability.availability === 'available'
          && capability.operations.some((entry) => entry.id === 'sessions.thinking.get')
          && (draft || capability.operations.some((entry) => entry.id === 'sessions.thinking.set'));
        const result: SessionThinkingResult = supported
          ? await hostSessionThinkingGet({ scope: target, ...(modelHint ? { modelSelectionId: modelHint } : {}) }, { traceId })
          : { runtime, outcome: capability.availability === 'unavailable' ? 'unavailable' : 'unsupported' };
        logSessionTrace('thinking.read.settle', traceId, () => ({ outcome: result.outcome, stale: !isCurrent() }));
        if (isCurrent()) setState((current) => ({
          request, result, switching: false,
          ...(current.request === request && current.writeResult?.outcome === 'confirmed'
            && result.outcome === 'available' && current.writeResult.level === result.level ? { writeResult: current.writeResult } : {}),
        }));
      })
      .catch((error) => {
        logSessionTrace('thinking.read.error', traceId, () => ({ ...summarizeError(error), stale: !isCurrent() }));
        if (!isCurrent()) return;
        setState({ request, result: { runtime, outcome: 'unavailable' }, switching: false });
      });
    return () => { cancelled = true; };
  }, [draft, modelHint, modelKey, modelSwitching, preview, ready, request, runtime, scopeKey, target]);

  // The conversation owns the last result; the request determines whether it is current.
  const result = state.request.owner === owner ? state.result : null;
  const snapshot = result?.outcome === 'available' || result?.outcome === 'confirmed' ? result : null;
  const isCurrentRequest = state.request === request;
  const intended = pendingSelection?.runtime === runtime ? pendingSelection : undefined;
  const switching = isCurrentRequest && state.switching;
  const loading = ready && (!isCurrentRequest || !result);
  const options = useMemo(() => (snapshot?.options ?? []).map((level) => ({
    id: JSON.stringify(level), label: level, level,
  })), [snapshot?.options]);
  const requestedLevel = intended ? intended.level : snapshot?.level;
  const incompatible = isCurrentRequest && requestedLevel != null && (snapshot ? !snapshot.options.includes(requestedLevel) : result?.outcome === 'unsupported');
  const level = intended
    ? intended.level ?? (snapshot?.level === null ? snapshot.effectiveLevel : undefined)
    : snapshot?.effectiveLevel ?? snapshot?.level;
  const currentOption = incompatible ? undefined : options.find((option) => option.level === level);
  const canReset = Boolean(intended) || snapshot?.level != null || !draft && modelHint !== undefined;
  const disabled = !ready || initializationBusy || modelSwitching || switching || loading || options.length === 0 && !canReset;

  useEffect(() => {
    logSessionTrace('thinking.picker.state', createSessionTraceId('thinking-intent'), () => ({
      owner: summarizeIdentifier(scopeKey), model: summarizeIdentifier(modelKey), preview, activeRun,
      pendingIntent: Boolean(intended), reset: intended?.level === null,
      requested: summarizeIdentifier(requestedLevel), effective: summarizeIdentifier(isCurrentRequest ? snapshot?.effectiveLevel : undefined),
      options: isCurrentRequest ? snapshot?.options.map((option) => summarizeIdentifier(option)) ?? [] : [],
      incompatible, canReset, disabled,
    }));
  }, [activeRun, canReset, disabled, incompatible, intended, isCurrentRequest, modelKey, preview, requestedLevel, scopeKey, snapshot]);

  const selectLevel = useCallback((level: string | null) => {
    const operation = operationRef.current;
    if (disabled || !runtime || operation?.request !== request || operation.switching) return;
    const selection: ComposerThinkingSelection = { runtime, level };
    if (draft || pendingConfiguration) {
      setState((current) => current.request === request ? { ...current, writeResult: undefined } : current);
      onSelectIntent(selection);
      return;
    }
    if (!identity || level === snapshot?.level && !incompatible) return;
    const traceId = createSessionTraceId('thinking-write');
    operation.switching = true;
    const sequence = ++operation.sequence;
    const isCurrent = () => operationRef.current === operation && operation.sequence === sequence;
    setState((current) => ({ ...current, request, switching: true, writeResult: undefined }));
    void executeSessionThinkingSelection({
      get: useChatStore.getState, set: useChatStore.setState, subscribe: useChatStore.subscribe,
    }, recordKey, selection, traceId).then((next) => {
      logSessionTrace('thinking.write.settle', traceId, () => ({ outcome: next.outcome, stale: !isCurrent() }));
      if (!isCurrent()) return;
      setState((current) => ({
        request, result: next.outcome === 'confirmed' || next.outcome === 'available' ? next : current.result,
        switching: false, writeResult: next,
      }));
    }).catch((error) => {
      logSessionTrace('thinking.write.error', traceId, () => ({ ...summarizeError(error), stale: !isCurrent() }));
      if (!isCurrent()) return;
      setState((current) => ({ ...current, switching: false, writeResult: { runtime, outcome: 'unknown' } }));
    }).finally(() => { operation.switching = false; });
  }, [disabled, draft, identity, incompatible, onSelectIntent, pendingConfiguration, recordKey, request, runtime, snapshot?.level]);

  const onSelect = useCallback((id: string) => {
    const option = options.find((candidate) => candidate.id === id);
    if (option) selectLevel(option.level);
  }, [options, selectLevel]);
  const onReset = useCallback(() => selectLevel(null), [selectLevel]);

  const writeResult = isCurrentRequest ? state.writeResult : undefined;
  if (!runtime || !snapshot && !intended && (!isCurrentRequest || !result)) return null;
  if (isCurrentRequest && !intended && !canReset && (result?.outcome === 'unsupported' || writeResult?.outcome === 'unsupported'
    || snapshot && options.length === 0)) return null;
  return {
    currentId: currentOption?.id ?? null,
    label: incompatible ? t('input.thinkingReselect')
      : intended?.level === null ? t('input.thinkingReset')
        : currentOption?.label ?? level ?? t('input.thinkingPickLevel'),
    options, loading, switching, disabled, onSelect,
    ...(canReset ? { onReset } : {}),
  };
}
