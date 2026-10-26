import { useCallback, useEffect, useMemo, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { CheckCircle2, CircleAlert, Clock3, Loader2, RefreshCw, X, XCircle } from 'lucide-react';
import type { SessionRunPhase } from '@/types/session/runtime-state';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ChatComposerPanelProps } from '@/plugins/chat/extensions';
import { useSessionConnectorStatusStore, type SessionConnectorStatus, type SessionConnectorStatusResultType } from './session-status-store';
import {
  buildSessionIdentityKey,
  type SessionIdentity,
} from '@/types/desktop/runtime-address';

const EMPTY_SESSION_CONNECTOR_STATUSES: SessionConnectorStatus[] = [];
const CONNECTOR_STATUS_REFRESH_PHASES = new Set<SessionRunPhase>(['submitted', 'streaming', 'done', 'error', 'aborted']);
const CONNECTOR_STATUS_REFRESH_TERMINAL_PHASES = new Set<SessionRunPhase>(['done', 'error', 'aborted']);

export function SessionStatusPanel({
  sessionIdentity,
  activeRunId = null,
  runPhase = null,
  open,
  onOpenChange,
  returnFocusRef,
}: ChatComposerPanelProps) {
  const navigate = useNavigate();
  const { t } = useTranslation("chat");
  const autoRefreshKeyRef = useRef<string>('');
  const sessionIdentityKey = useMemo(
    () => (sessionIdentity ? buildSessionIdentityKey(sessionIdentity) : ''),
    [sessionIdentity],
  );
  const statuses = useSessionConnectorStatusStore((state) => (
    sessionIdentityKey ? state.statusesBySessionKey[sessionIdentityKey] ?? EMPTY_SESSION_CONNECTOR_STATUSES : EMPTY_SESSION_CONNECTOR_STATUSES
  ));
  const loading = useSessionConnectorStatusStore((state) => (
    sessionIdentityKey ? state.loadingBySessionKey[sessionIdentityKey] === true : false
  ));
  const error = useSessionConnectorStatusStore((state) => (
    sessionIdentityKey ? state.errorBySessionKey[sessionIdentityKey] ?? null : null
  ));
  const refreshSessionStatus = useSessionConnectorStatusStore((state) => state.refreshSessionStatus);
  const setSessionMcpServerEnabled = useSessionConnectorStatusStore((state) => state.setSessionMcpServerEnabled);

  const refresh = useCallback(() => {
    if (!sessionIdentity) {
      return;
    }
    void refreshSessionStatus(sessionIdentity).catch(() => undefined);
  }, [refreshSessionStatus, sessionIdentity]);

  useEffect(() => {
    if (!sessionIdentity) {
      return;
    }
    void refreshSessionStatus(sessionIdentity).catch(() => undefined);
  }, [refreshSessionStatus, sessionIdentity, sessionIdentityKey]);

  useEffect(() => {
    if (!sessionIdentity || !runPhase || !CONNECTOR_STATUS_REFRESH_PHASES.has(runPhase)) {
      return;
    }
    if (!activeRunId && !CONNECTOR_STATUS_REFRESH_TERMINAL_PHASES.has(runPhase)) {
      return;
    }
    const refreshKey = `${sessionIdentityKey}:${activeRunId ?? 'terminal'}:${runPhase}`;
    if (autoRefreshKeyRef.current === refreshKey) {
      return;
    }
    autoRefreshKeyRef.current = refreshKey;
    void refreshSessionStatus(sessionIdentity).catch(() => undefined);
  }, [activeRunId, refreshSessionStatus, runPhase, sessionIdentity, sessionIdentityKey]);

  const summary = summarizeStatuses(statuses, loading, error, sessionIdentity, t);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[120] bg-[hsl(var(--shell-scrim))]" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}
          className="fixed left-1/2 top-1/2 z-[120] flex max-h-[calc(100dvh-24px)] w-[360px] max-w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-elevated outline-none"
        >
          <header className="flex items-start justify-between gap-3 border-b border-border/45 px-3.5 py-3">
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold">{t("input.sessionConnectors")}</Dialog.Title>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{summary.label}</div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-full"
              aria-label={t("input.refreshConnectors")}
              title={t("input.refreshConnectors")}
              onClick={refresh}
              disabled={loading}
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={t("input.closePanel")}>
                <X aria-hidden="true" className="h-4 w-4" />
              </Button>
            </Dialog.Close>
          </header>

          <div className="min-h-0 overflow-y-auto overscroll-contain p-2">
            {error ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : null}
            {!error && statuses.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">
                {t(loading ? "input.connectorsLoading" : "input.connectorsEmpty")}
              </div>
            ) : null}
            {statuses.length > 0 ? (
              <div className="space-y-1.5">
                {statuses.map((status) => (
                  <ConnectorStatusRow
                    key={`${status.adapterId}:${status.connectorId}`}
                    status={status}
                    sessionIdentity={sessionIdentity}
                    onSetEnabled={setSessionMcpServerEnabled}
                  />
                ))}
              </div>
            ) : null}
          </div>

          <footer className="border-t border-border/45 p-2">
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
              onClick={() => {
                onOpenChange(false);
                navigate('/connectors');
              }}
            >
              <span>{t("input.moreConnectors")}</span>
              <span aria-hidden="true">→</span>
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ConnectorStatusRow({
  status,
  sessionIdentity,
  onSetEnabled,
}: {
  readonly status: SessionConnectorStatus;
  readonly sessionIdentity: SessionIdentity | null;
  readonly onSetEnabled: (sessionIdentity: SessionIdentity, serverId: string, enabled: boolean) => Promise<void>;
}) {
  const { t } = useTranslation("chat");
  const meta = statusMeta(status.resultType, t);
  const toolCount = status.details?.toolCount;
  const serverId = status.details?.serverId;
  const enabledNextRun = status.details?.enabledNextRun;
  const nextEnabled = sessionIdentity && serverId && status.details?.enabledConfigurable === true && status.resultType !== 'unsupported'
    ? enabledNextRun === false
    : null;
  const pendingText = enabledNextRun === false
    ? t("input.connectorDisabled")
    : enabledNextRun === true && status.resultType === 'disabled'
      ? t("input.connectorEnabled")
      : null;
  return (
    <div className="flex items-center gap-2.5 rounded-xl px-2.5 py-2 transition-colors hover:bg-muted/55">
      <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', meta.iconClass)}>
        {meta.icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{status.displayName || status.connectorId}</span>
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', meta.badgeClass)}>{meta.label}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">
            {pendingText ?? (toolCount !== undefined ? t("input.connectorToolCount", { count: toolCount }) : status.reason ?? status.adapterId)}
          </span>
          {nextEnabled !== null ? (
            <button
              type="button"
              className="shrink-0 rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                if (!sessionIdentity || !serverId) return;
                void onSetEnabled(sessionIdentity, serverId, nextEnabled)
                  .then(() => toast.success(t(nextEnabled ? 'input.connectorEnabled' : 'input.connectorDisabled')))
                  .catch((error) => toast.error(error instanceof Error ? error.message : t("input.connectorUpdateFailed")));
              }}
            >
              {t(nextEnabled ? "input.connectorEnable" : "input.connectorDisable")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function summarizeStatuses(
  statuses: readonly SessionConnectorStatus[],
  loading: boolean,
  error: string | null,
  sessionIdentity: SessionIdentity | null,
  t: TFunction<"chat">,
): { readonly resultType: SessionConnectorStatusResultType; readonly label: string } {
  if (!sessionIdentity) {
    return { resultType: 'unknown', label: t("input.connectorNoSession") };
  }
  if (loading && statuses.length === 0) {
    return { resultType: 'pending', label: t("input.connectorsLoading") };
  }
  if (error) {
    return { resultType: 'error', label: t("input.connectorsLoadFailed") };
  }
  const connectedCount = statuses.filter((status) => status.resultType === 'connected').length;
  if (connectedCount > 0) {
    return { resultType: 'connected', label: t("input.connectorsConnected", { count: connectedCount }) };
  }
  if (statuses.some((status) => status.resultType === 'pending')) {
    return { resultType: 'pending', label: t("input.connectorsWaiting") };
  }
  if (statuses.length > 0) {
    return { resultType: 'unknown', label: t("input.connectorsUndetected") };
  }
  return { resultType: 'unknown', label: t("input.connectorsEmpty") };
}

function statusMeta(resultType: SessionConnectorStatusResultType, t: TFunction<"chat">) {
  if (resultType === 'connected') {
    return {
      label: t("input.connectorConnected"),
      icon: <CheckCircle2 className="h-4 w-4" />,
      iconClass: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
      badgeClass: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    };
  }
  if (resultType === 'disconnected' || resultType === 'error') {
    return {
      label: t(resultType === "error" ? "input.connectorError" : "input.connectorDisconnected"),
      icon: <XCircle className="h-4 w-4" />,
      iconClass: 'bg-destructive/10 text-destructive',
      badgeClass: 'bg-destructive/10 text-destructive',
    };
  }
  if (resultType === 'pending') {
    return {
      label: t("input.connectorPending"),
      icon: <Clock3 className="h-4 w-4" />,
      iconClass: 'bg-amber-500/12 text-amber-700 dark:text-amber-300',
      badgeClass: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    };
  }
  return {
    label: t(resultType === "disabled" ? "input.connectorDisabled" : resultType === "unsupported" ? "input.connectorUnsupported" : "input.connectorUnknown"),
    icon: <CircleAlert className="h-4 w-4" />,
    iconClass: 'bg-muted text-muted-foreground',
    badgeClass: 'bg-muted text-muted-foreground',
  };
}
