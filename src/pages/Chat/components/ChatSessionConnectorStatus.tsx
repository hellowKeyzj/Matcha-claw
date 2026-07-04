import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { waitForRuntimeJobResult } from '@/lib/host-api';
import { Cable, CheckCircle2, CircleAlert, Clock3, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useSessionConnectorStatusStore, type SessionConnectorStatus, type SessionConnectorStatusResultType } from '@/stores/session-connector-status';
import { buildSessionIdentityKey, type SessionIdentity } from '../../../../runtime-host/shared/runtime-address';

interface ChatSessionConnectorStatusProps {
  readonly sessionIdentity: SessionIdentity | null;
  readonly disabled?: boolean;
}

const EMPTY_SESSION_CONNECTOR_STATUSES: SessionConnectorStatus[] = [];

export function ChatSessionConnectorStatus({
  sessionIdentity,
  disabled = false,
}: ChatSessionConnectorStatusProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
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
  }, [refreshSessionStatus, sessionIdentityKey]);

  useEffect(() => {
    if (!sessionIdentity) {
      return;
    }
    const refreshJobIds = Array.from(new Set(statuses
      .map((status) => status.details?.refreshJobId)
      .filter((jobId): jobId is string => typeof jobId === 'string' && jobId.length > 0)));
    if (refreshJobIds.length === 0) {
      return;
    }

    let cancelled = false;
    for (const refreshJobId of refreshJobIds) {
      void waitForRuntimeJobResult(refreshJobId, { endpoint: sessionIdentity.endpoint })
        .then(() => {
          if (cancelled) {
            return;
          }
          void refreshSessionStatus(sessionIdentity).catch(() => undefined);
        })
        .catch(() => undefined);
    }

    return () => {
      cancelled = true;
    };
  }, [refreshSessionStatus, sessionIdentity, statuses]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (rootRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const summary = summarizeStatuses(statuses, loading, error, sessionIdentity);
  const triggerDisabled = disabled || !sessionIdentity;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          'relative h-8 w-8 rounded-full border border-border/45 bg-background/74 text-muted-foreground shadow-sm hover:bg-background/88 hover:text-foreground',
          open && 'bg-background/90 text-foreground',
          triggerDisabled && 'cursor-not-allowed opacity-55',
        )}
        disabled={triggerDisabled}
        aria-label="会话连接器状态"
        title={summary.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (triggerDisabled) {
            return;
          }
          setOpen((current) => !current);
        }}
      >
        <Cable className="h-4 w-4" />
        <span className={cn(
          'absolute right-0.5 top-0.5 h-2 w-2 rounded-full border border-background',
          statusDotClass(summary.resultType),
        )} />
      </Button>

      {open ? (
        <section
          role="dialog"
          aria-label="当前会话连接器状态"
          className="absolute bottom-full left-0 z-50 mb-2 w-[20rem] overflow-hidden rounded-2xl border border-border/60 bg-popover text-popover-foreground shadow-[0_18px_55px_rgba(15,23,42,0.22)] backdrop-blur-xl"
        >
          <header className="flex items-start justify-between gap-3 border-b border-border/45 px-3.5 py-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold">当前会话连接器</div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{summary.label}</div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-full"
              aria-label="刷新会话连接器状态"
              title="刷新"
              onClick={refresh}
              disabled={loading}
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </header>

          <div className="max-h-[19rem] overflow-y-auto p-2">
            {error ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : null}
            {!error && statuses.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">
                {loading ? '正在读取当前会话连接器状态…' : '当前会话没有可展示的连接器状态。'}
              </div>
            ) : null}
            {statuses.length > 0 ? (
              <div className="space-y-1.5">
                {statuses.map((status) => <ConnectorStatusRow key={`${status.adapterId}:${status.connectorId}`} status={status} />)}
              </div>
            ) : null}
          </div>

          <footer className="border-t border-border/45 p-2">
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
              onClick={() => {
                setOpen(false);
                navigate('/connectors');
              }}
            >
              <span>更多连接器</span>
              <span aria-hidden="true">→</span>
            </button>
          </footer>
        </section>
      ) : null}
    </div>
  );
}

function ConnectorStatusRow({ status }: { readonly status: SessionConnectorStatus }) {
  const meta = statusMeta(status.resultType);
  const toolCount = status.details?.toolCount;
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
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {toolCount !== undefined ? `${toolCount} 个工具` : status.reason ?? status.adapterId}
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
): { readonly resultType: SessionConnectorStatusResultType; readonly label: string } {
  if (!sessionIdentity) {
    return { resultType: 'unknown', label: '没有当前会话' };
  }
  if (loading && statuses.length === 0) {
    return { resultType: 'pending', label: '正在读取连接器状态' };
  }
  if (error) {
    return { resultType: 'error', label: '连接器状态读取失败' };
  }
  const connectedCount = statuses.filter((status) => status.resultType === 'connected').length;
  if (connectedCount > 0) {
    return { resultType: 'connected', label: `${connectedCount} 个连接器已连接` };
  }
  if (statuses.some((status) => status.resultType === 'pending')) {
    return { resultType: 'pending', label: '连接器等待会话使用' };
  }
  if (statuses.length > 0) {
    return { resultType: 'unknown', label: '连接器未连接或不可检测' };
  }
  return { resultType: 'unknown', label: '暂无连接器状态' };
}

function statusMeta(resultType: SessionConnectorStatusResultType) {
  if (resultType === 'connected') {
    return {
      label: '已连接',
      icon: <CheckCircle2 className="h-4 w-4" />,
      iconClass: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
      badgeClass: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    };
  }
  if (resultType === 'disconnected' || resultType === 'error') {
    return {
      label: resultType === 'error' ? '错误' : '未连接',
      icon: <XCircle className="h-4 w-4" />,
      iconClass: 'bg-destructive/10 text-destructive',
      badgeClass: 'bg-destructive/10 text-destructive',
    };
  }
  if (resultType === 'pending') {
    return {
      label: '待连接',
      icon: <Clock3 className="h-4 w-4" />,
      iconClass: 'bg-amber-500/12 text-amber-700 dark:text-amber-300',
      badgeClass: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    };
  }
  return {
    label: resultType === 'disabled' ? '未启用' : resultType === 'unsupported' ? '不支持' : '未知',
    icon: <CircleAlert className="h-4 w-4" />,
    iconClass: 'bg-muted text-muted-foreground',
    badgeClass: 'bg-muted text-muted-foreground',
  };
}

function statusDotClass(resultType: SessionConnectorStatusResultType): string {
  if (resultType === 'connected') {
    return 'bg-emerald-500';
  }
  if (resultType === 'pending') {
    return 'bg-amber-500';
  }
  if (resultType === 'error' || resultType === 'disconnected') {
    return 'bg-destructive';
  }
  return 'bg-muted-foreground';
}
