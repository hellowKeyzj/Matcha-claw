import { useLayoutEffect, useRef, useState } from 'react';
import { Pin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { boardExecute } from '../board-api';
import { decodeBoardFailure, type BoardFailure } from '@/types/board';
import { useBoardStore } from '@/plugins/surfaces/board/store';
import { RuntimeContentHost } from '@/plugins/surfaces/RuntimeContentHost';
import type { OpenClawRuntimeSurfaceDescriptor } from '@/types/openclaw-runtime-surface';
import { sessionIdentitiesEqual } from '@/types/desktop/runtime-address';

type RuntimeActions = {
  onSendMessage?: (text: string) => void | Promise<void>;
  onOpenLink?: (url: string) => void | Promise<void>;
};

export function NativeSurfacePanel({ surface, onSendMessage, onOpenLink }: RuntimeActions & { surface: OpenClawRuntimeSurfaceDescriptor }) {
  const { t } = useTranslation('chat');
  const active = useRef(false);
  const [widgetName] = useState(() => `surface-${crypto.randomUUID()}`);
  const [pinStatus, setPinStatus] = useState<'idle' | 'pending' | 'pinned' | 'unknown' | 'checking'>('idle');
  const [pinError, setPinError] = useState<string | null>(null);
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  const pin = async () => {
    if (!active.current || pinStatus !== 'idle') return;
    const { sessionIdentity } = surface;
    if (sessionIdentity.endpoint.kind !== 'native-runtime' || sessionIdentity.endpoint.runtimeAdapterId !== 'openclaw') return;
    const identity = { ...sessionIdentity, endpoint: sessionIdentity.endpoint };
    setPinStatus('pending');
    setPinError(null);
    try {
      await boardExecute(identity, {
        method: 'board.widget.put',
        name: widgetName,
        ...(surface.title ? { title: Array.from(surface.title).slice(0, 80).join('') } : {}),
        content: surface.kind === 'mcp-app'
          ? { kind: 'mcp-app', viewId: surface.viewId }
          : { kind: 'canvas-doc', docId: surface.documentId },
        placement: { size: 'full' },
      });
      if (!active.current) return;
      setPinStatus('pinned');
      const board = useBoardStore.getState();
      if (board.identity && sessionIdentitiesEqual(board.identity, identity)) void board.refresh();
    } catch (error) {
      if (!active.current) return;
      let failure: BoardFailure;
      try {
        failure = decodeBoardFailure(error instanceof Error && 'code' in error ? { code: error.code, message: error.message } : error);
      } catch {
        failure = { code: 'unknown', message: t('board.pinFailed', { defaultValue: 'Could not confirm the pin. Refresh the board before trying again.' }) };
      }
      setPinStatus(failure.code === 'unknown' || failure.code === 'stale' ? 'unknown' : 'idle');
      setPinError(failure.message);
    }
  };

  const confirmPin = async () => {
    if (!active.current || pinStatus !== 'unknown') return;
    const { sessionIdentity } = surface;
    if (sessionIdentity.endpoint.kind !== 'native-runtime' || sessionIdentity.endpoint.runtimeAdapterId !== 'openclaw') return;
    setPinStatus('checking');
    try {
      const snapshot = await boardExecute({ ...sessionIdentity, endpoint: sessionIdentity.endpoint }, { method: 'board.get' });
      if (!active.current) return;
      setPinStatus(snapshot.widgets.some((widget) => widget.name === widgetName) ? 'pinned' : 'idle');
      setPinError(null);
    } catch (error) {
      if (!active.current) return;
      setPinStatus('unknown');
      setPinError(error instanceof Error ? error.message : t('board.pinFailed', { defaultValue: 'Could not confirm the pin. Refresh the board before trying again.' }));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{surface.title || (surface.kind === 'mcp-app' ? 'MCP App' : 'Canvas')}</span>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" disabled={pinStatus !== 'idle'} onClick={() => void pin()}>
          <Pin className="h-3.5 w-3.5" />
          {pinStatus === 'pinned' ? t('board.pinned', { defaultValue: 'Pinned to Board' }) : t('board.pinToBoard', { defaultValue: 'Pin to Board' })}
        </Button>
      </div>
      {pinError ? <div className="flex items-center gap-2 px-3 py-2">
        <p role="alert" className="flex-1 text-xs text-destructive">{pinError}</p>
        {pinStatus === 'unknown' || pinStatus === 'checking' ? <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2" disabled={pinStatus === 'checking'} onClick={() => void confirmPin()}>{t('board.refresh', { defaultValue: 'Refresh board' })}</Button> : null}
      </div> : null}
      <RuntimeContentHost
        source={surface.kind === 'mcp-app' ? { kind: 'mcp-app', descriptor: surface } : { kind: 'canvas', descriptor: surface }}
        onSendMessage={onSendMessage}
        onOpenLink={onOpenLink}
        className="min-h-0 flex-1"
      />
    </div>
  );
}
