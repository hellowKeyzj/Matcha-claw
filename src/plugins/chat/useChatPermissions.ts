import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { hostCapabilityDescribe, hostSessionPermissionGet, hostSessionPermissionSet } from '@/lib/host-api';
import { buildCapabilityScopeKey, sessionScope, type AgentScope, type SessionIdentity } from '@/types/desktop/runtime-address';
import { NATIVE_PERMISSION_MODES } from '@/types/native-policy';
import { OPENCLAW_PERMISSION_MODES, type SessionPermissionResult, type SessionPermissionSelection } from '@/types/session-permission';

type PermissionTone = 'neutral' | 'positive' | 'warning';
export type PermissionPickerState = {
  currentId: string | null;
  label: string;
  status: string | null;
  tone: PermissionTone;
  busy: boolean;
  disabled: boolean;
  options: { id: string; label: string; description: string; disabled?: boolean; disabledReason?: string }[];
  onSelect: (id: string) => void;
};

const OPENCLAW_LABELS = {
  'read-only': 'permissionReadOnly', guarded: 'permissionGuarded', workspace: 'permissionWorkspace', full: 'permissionFull',
} as const;
const NATIVE_LABELS = {
  default: 'permissionNativeDefault', acceptEdits: 'permissionAcceptEdits', bypassPermissions: 'permissionBypass',
  plan: 'permissionPlan', dontAsk: 'permissionDontAsk', auto: 'permissionAuto',
} as const;

function permissionRuntime(scope: AgentScope | null): 'openclaw' | 'matcha-agent' | null {
  const endpoint = scope?.endpoint;
  return endpoint?.kind === 'native-runtime'
    && (endpoint.runtimeAdapterId === 'openclaw' || endpoint.runtimeAdapterId === 'matcha-agent')
    ? endpoint.runtimeAdapterId : null;
}

function selectionId(selection: SessionPermissionSelection): string {
  return selection.mode ?? 'inherit';
}

function selectionTone(selection: SessionPermissionSelection): PermissionTone {
  if (selection.mode === 'full' || selection.mode === 'bypassPermissions') return 'warning';
  return selection.mode === null ? 'positive' : 'neutral';
}

export function useChatPermissions({
  scope, identity, ready, activeRun, draft, draftAvailable, draftLoading, initializationBusy, pendingSelection, pendingConfiguration, onSelectIntent,
}: {
  scope: AgentScope | null;
  identity: SessionIdentity | null;
  ready: boolean;
  activeRun: boolean;
  draft: boolean;
  draftAvailable: boolean;
  draftLoading: boolean;
  initializationBusy: boolean;
  pendingSelection: SessionPermissionSelection | undefined;
  pendingConfiguration: boolean;
  onSelectIntent: (selection: SessionPermissionSelection) => void;
}): PermissionPickerState | null {
  const { t } = useTranslation('chat');
  const runtime = permissionRuntime(scope);
  const identityKey = identity ? buildCapabilityScopeKey(sessionScope(identity)) : '';
  const owner = useMemo(() => ({ identityKey, ready, pendingConfiguration }), [identityKey, pendingConfiguration, ready]);
  const operationRef = useRef<{ owner: typeof owner; sequence: number } | null>(null);
  const [state, setState] = useState<{
    owner: typeof owner; result: SessionPermissionResult | null; switching: boolean; rejected?: boolean;
  }>({ owner, result: null, switching: false });

  useLayoutEffect(() => {
    operationRef.current = ready && identityKey ? { owner, sequence: 0 } : null;
    return () => { operationRef.current = null; };
  }, [identityKey, owner, ready]);

  useEffect(() => {
    const operation = operationRef.current;
    if (draft || !ready || !identity || !runtime || operation?.owner !== owner) return;
    const sequence = ++operation.sequence;
    let cancelled = false;
    const isCurrent = () => !cancelled && operationRef.current === operation && operation.sequence === sequence;
    void hostCapabilityDescribe({ id: 'session.management', scope: sessionScope(identity) })
      .then(async ({ capability }) => {
        if (!isCurrent()) return;
        const supported = capability.availability === 'available'
          && ['sessions.permission.get', 'sessions.permission.set'].every((id) => capability.operations.some((operation) => operation.id === id));
        const result: SessionPermissionResult = supported ? await hostSessionPermissionGet({ identity })
          : { runtime, outcome: capability.availability === 'unavailable' ? 'unavailable' as const : 'unsupported' as const };
        if (isCurrent()) setState({ owner, result, switching: false });
      })
      .catch((error) => {
        if (!isCurrent()) return;
        setState({ owner, result: { runtime, outcome: 'unavailable' }, switching: false });
        toast.error(t('input.permissionLoadFailed', { error: error instanceof Error ? error.message : String(error) }));
      });
    return () => { cancelled = true; };
  }, [draft, identity, owner, pendingConfiguration, ready, runtime, t]);

  const result = state.owner === owner ? state.result : null;
  const loading = draft ? draftLoading : ready && !result;
  const switching = state.owner === owner && state.switching;
  const available = draft ? draftAvailable : result?.outcome === 'available' || result?.outcome === 'confirmed';
  const nativePending = result?.runtime === 'openclaw' && result.outcome === 'available' && result.pending;
  const options = useMemo(() => {
    if (!runtime) return [];
    const selections: SessionPermissionSelection[] = runtime === 'openclaw'
      ? [{ runtime, mode: null }, ...OPENCLAW_PERMISSION_MODES.map((mode): SessionPermissionSelection => ({ runtime, mode }))]
      : NATIVE_PERMISSION_MODES.map((mode): SessionPermissionSelection => ({ runtime, mode }));
    return selections.filter((selection) => draft || !result || result.outcome !== 'available' || result.runtime !== 'openclaw'
      || selection.mode === null || result.options.some((mode) => mode === selection.mode)).map((selection) => {
      const key = selection.runtime === 'openclaw'
        ? selection.mode === null ? 'permissionDefault' : OPENCLAW_LABELS[selection.mode]
        : NATIVE_LABELS[selection.mode];
      const disabled = !draft && selection.mode === 'full' && result?.runtime === 'openclaw'
        && result.outcome === 'available' && !result.canSelectFull;
      return {
        id: selectionId(selection), selection,
        label: selection.runtime === 'openclaw' && selection.mode === null && result?.runtime === 'openclaw'
          && result.outcome === 'available' && result.defaultMode
          ? t('input.permissionDefaultWithMode', { mode: t(`input.${OPENCLAW_LABELS[result.defaultMode]}`) }) : t(`input.${key}`),
        description: t(`input.${key}Description`), disabled,
        ...(disabled ? { disabledReason: t('input.permissionFullRequiresAccess') } : {}),
      };
    });
  }, [draft, result, runtime, t]);
  const nativeSelection = useMemo<SessionPermissionSelection | null>(() => result?.outcome === 'available'
    ? result.runtime === 'openclaw' ? { runtime: result.runtime, mode: result.mode }
      : result.mode === null ? null : { runtime: result.runtime, mode: result.mode }
    : result?.outcome === 'confirmed' ? { runtime: result.runtime, mode: result.mode } : null, [result]);
  const intended = pendingSelection?.runtime === runtime ? pendingSelection : undefined;
  const selection = intended ?? nativeSelection;
  const selectedOption = selection ? options.find((option) => option.id === selectionId(selection)) : undefined;
  const disabled = !ready || activeRun || initializationBusy || !available || loading || switching || nativePending;

  const onSelect = useCallback((id: string) => {
    const option = options.find((candidate) => candidate.id === id);
    if (disabled || !option || option.disabled) return;
    if (draft || pendingConfiguration) {
      onSelectIntent(option.selection);
      return;
    }
    const operation = operationRef.current;
    if (!identity || operation?.owner !== owner || id === (nativeSelection ? selectionId(nativeSelection) : null)) return;
    const sequence = ++operation.sequence;
    const isCurrent = () => operationRef.current === operation && operation.sequence === sequence;
    setState((current) => ({ ...current, switching: true, rejected: false }));
    void hostSessionPermissionSet({ identity, selection: option.selection })
      .then((next) => {
        if (!isCurrent()) return;
        setState((current) => next.outcome === 'rejected'
          ? { ...current, switching: false, rejected: true }
          : { owner, result: next, switching: false });
      })
      .catch((error) => {
        if (!isCurrent() || !runtime) return;
        setState({ owner, result: { runtime, outcome: 'unknown' }, switching: false });
        toast.error(t('input.permissionSwitchFailed', { error: error instanceof Error ? error.message : String(error) }));
      });
  }, [disabled, draft, identity, nativeSelection, onSelectIntent, options, owner, pendingConfiguration, runtime, t]);

  if (!runtime) return null;
  let status: string | null = null;
  if (switching || nativePending) status = t('input.permissionPending');
  else if (loading) status = t('input.permissionLoading');
  else if (!ready) status = t('input.permissionUnavailable');
  else if (result?.outcome === 'unknown') status = t('input.permissionUnknown');
  else if (state.owner === owner && state.rejected || result?.outcome === 'rejected') status = t('input.permissionRejected');
  else if (!available) status = t(result?.outcome === 'unavailable' ? 'input.permissionUnavailable' : 'input.permissionUnsupported');
  else if (result?.runtime === 'matcha-agent' && result.outcome === 'confirmed' && !result.applied) {
    status = t('input.permissionSavedNotApplied');
  }
  return {
    currentId: selectedOption?.id ?? null,
    label: selectedOption?.label ?? t('input.pickPermissionMode'), status,
    tone: state.owner === owner && state.rejected || result?.outcome === 'unknown' || result?.outcome === 'rejected' ? 'warning'
      : selection ? selectionTone(selection) : 'neutral',
    busy: loading || switching || nativePending,
    disabled,
    options: available ? options : [],
    onSelect,
  };
}
