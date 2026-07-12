import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, PlugZap, RefreshCw, SquareTerminal } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { RemoteFleetTerminalOpenResult } from '@/stores/remote-fleet';
import { cn } from '@/lib/utils';
import type {
  RemoteFleetTerminalConnectionRequest,
  RemoteFleetTerminalDrawerTarget,
  RemoteFleetTerminalErrorKind,
} from './remote-fleet-terminal-types';
import { useRemoteFleetTerminal } from './useRemoteFleetTerminal';

interface RemoteFleetTerminalDrawerProps {
  readonly open: boolean;
  readonly target: RemoteFleetTerminalDrawerTarget | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly openTerminal: (request: RemoteFleetTerminalConnectionRequest) => Promise<RemoteFleetTerminalOpenResult>;
  readonly reconnectTerminal: (sessionId: string) => Promise<RemoteFleetTerminalOpenResult>;
  readonly closeTerminal: (sessionId: string, reason?: string) => Promise<void>;
}

const TERMINAL_ERROR_MESSAGES = {
  'open-failed': {
    key: 'remoteFleet.terminal.errors.openFailed',
    defaultValue: 'Could not open the terminal. Check that the target is available, then try again.',
  },
  'connection-failed': {
    key: 'remoteFleet.terminal.errors.connectionFailed',
    defaultValue: 'The terminal connection was interrupted. Try reconnecting.',
  },
  'remote-error': {
    key: 'remoteFleet.terminal.errors.remoteError',
    defaultValue: 'The remote terminal reported an error. Check the target status, then try again.',
  },
  'reconnect-failed': {
    key: 'remoteFleet.terminal.errors.reconnectFailed',
    defaultValue: 'Could not reconnect to the terminal. Check that the target is available, then try again.',
  },
} as const satisfies Record<RemoteFleetTerminalErrorKind, { readonly key: string; readonly defaultValue: string }>;

function terminalStatusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'ready') return 'secondary';
  if (status === 'error') return 'destructive';
  if (status === 'opening' || status === 'connecting') return 'default';
  return 'outline';
}

export function RemoteFleetTerminalDrawer({
  open,
  target,
  onOpenChange,
  openTerminal,
  reconnectTerminal,
  closeTerminal,
}: RemoteFleetTerminalDrawerProps) {
  const { t } = useTranslation('common');
  const terminal = useRemoteFleetTerminal({ openTerminal, reconnectTerminal, closeTerminal });
  const isBusy = terminal.snapshot.status === 'opening' || terminal.snapshot.status === 'connecting';
  const canReconnect = Boolean(terminal.snapshot.session?.id) && !isBusy;
  const terminalErrorMessage = terminal.snapshot.errorKind
    ? TERMINAL_ERROR_MESSAGES[terminal.snapshot.errorKind]
    : null;

  useEffect(() => {
    if (!open || !target || target.unavailableReason) return;
    void terminal.connect({ target }).catch(() => undefined);
  }, [open, target, terminal.connect]);

  const updateOpen = useCallback((nextOpen: boolean) => {
    onOpenChange(nextOpen);
  }, [onOpenChange]);

  const closeTerminalSession = useCallback(() => {
    void terminal.close('terminal closed').catch(() => undefined);
    onOpenChange(false);
  }, [onOpenChange, terminal]);

  return (
    <Sheet open={open} onOpenChange={updateOpen}>
      <SheetContent side="right" showCloseButton={false} className="flex w-full flex-col gap-4 overflow-hidden sm:max-w-5xl">
        <SheetHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="gap-1">
              <SquareTerminal className="h-3.5 w-3.5" />
              {t('remoteFleet.terminal.badge')}
            </Badge>
            <Badge variant={terminalStatusVariant(terminal.snapshot.status)}>
              {t(`remoteFleet.terminal.status.${terminal.snapshot.status}`)}
            </Badge>
          </div>
          <SheetTitle>{target?.title ?? t('remoteFleet.terminal.title')}</SheetTitle>
          <SheetDescription className="sr-only">
            {t('remoteFleet.terminal.description')}
          </SheetDescription>
        </SheetHeader>

        {target?.unavailableReason ? (
          <div className="rounded-xl border border-border/70 bg-muted/30 p-4 text-sm text-muted-foreground">
            <div className="font-medium text-foreground">{t('remoteFleet.terminal.unavailableTitle')}</div>
            <p className="mt-1">{target.unavailableReason}</p>
          </div>
        ) : null}

        {terminalErrorMessage ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {t(terminalErrorMessage.key, { defaultValue: terminalErrorMessage.defaultValue })}
          </div>
        ) : null}

        {terminal.snapshot.status === 'exited' ? (
          <div className="rounded-xl border border-border/70 bg-muted/30 p-3 text-sm text-muted-foreground">
            {t('remoteFleet.terminal.exitMessage', {
              code: terminal.snapshot.exitCode ?? t('remoteFleet.common.unknown'),
              signal: terminal.snapshot.signal ?? t('remoteFleet.common.unknown'),
            })}
          </div>
        ) : null}

        <div
          ref={terminal.containerRef}
          aria-label={t('remoteFleet.terminal.terminalLabel')}
          className={cn(
            'min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-slate-950 p-2',
            target?.unavailableReason && 'pointer-events-none opacity-50',
          )}
        />

        <SheetFooter className="gap-2 sm:justify-between sm:space-x-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <PlugZap className="h-3.5 w-3.5" />
            {terminal.snapshot.session?.id ? t('remoteFleet.terminal.sessionActive') : t('remoteFleet.terminal.sessionPending')}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('remoteFleet.terminal.actions.reconnect')}
              title={t('remoteFleet.terminal.actions.reconnect')}
              onClick={() => void terminal.reconnect()}
              disabled={!canReconnect || Boolean(target?.unavailableReason)}
            >
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
            <Button type="button" variant="ghost" onClick={() => updateOpen(false)}>
              {t('remoteFleet.terminal.actions.minimize')}
            </Button>
            <Button type="button" variant="ghost" onClick={closeTerminalSession}>
              {t('remoteFleet.terminal.actions.close')}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
