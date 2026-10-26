import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { hostApiFetch } from '@/lib/host-api';

interface ProviderRecovery {
  backupDirectory: string;
}

export function ProviderRecoveryDialog({ queryEnabled, visible }: { queryEnabled: boolean; visible: boolean }) {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const [recovery, setRecovery] = useState<ProviderRecovery | null>(null);
  const [pending, setPending] = useState<'acknowledge' | 'open-backup' | null>(null);
  const [error, setError] = useState<'acknowledgeFailed' | 'openBackupFailed' | null>(null);
  const loaded = useRef(false);
  const notifyLoadFailed = useEffectEvent(() => {
    toast.error(t('providerRecovery.loadFailed'));
  });

  useEffect(() => {
    if (!queryEnabled || loaded.current) return;
    const controller = new AbortController();
    void hostApiFetch<unknown>('/api/providers/recovery', {
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted) return;
      if (!result || typeof result !== 'object' || Array.isArray(result)
        || Object.keys(result).length !== 1 || !('recovery' in result)) {
        throw new Error('Invalid provider recovery response');
      }
      const nextRecovery = result.recovery;
      if (nextRecovery === null) {
        loaded.current = true;
        return;
      }
      if (!nextRecovery || typeof nextRecovery !== 'object'
        || Array.isArray(nextRecovery) || Object.keys(nextRecovery).length !== 1
        || !('backupDirectory' in nextRecovery) || typeof nextRecovery.backupDirectory !== 'string'
        || !nextRecovery.backupDirectory.trim()) {
        throw new Error('Invalid provider recovery response');
      }
      loaded.current = true;
      setRecovery({ backupDirectory: nextRecovery.backupDirectory });
    }).catch(() => {
      if (!controller.signal.aborted) notifyLoadFailed();
    });
    return () => controller.abort();
  }, [queryEnabled]);

  async function acknowledge(addModel: boolean) {
    if (pending) return;
    setPending('acknowledge');
    setError(null);
    try {
      const result = await hostApiFetch<{ success: true }>('/api/providers/recovery/acknowledge', { method: 'POST' });
      if (result.success !== true) throw new Error('Provider recovery acknowledgement failed');
      setRecovery(null);
      if (addModel) navigate('/providers');
    } catch {
      setError('acknowledgeFailed');
    } finally {
      setPending(null);
    }
  }

  async function openBackup() {
    if (pending) return;
    setPending('open-backup');
    setError(null);
    try {
      const result = await hostApiFetch<{ success: true }>('/api/providers/recovery/open-backup', { method: 'POST' });
      if (result.success !== true) throw new Error('Provider recovery backup could not be opened');
    } catch {
      setError('openBackupFailed');
    } finally {
      setPending(null);
    }
  }

  return (
    <DialogPrimitive.Root open={visible && recovery !== null}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-50 w-[min(calc(100vw-2rem),480px)] -translate-x-1/2 -translate-y-1/2 rounded-[1.5rem] border border-border bg-background p-6 shadow-2xl focus:outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          aria-busy={pending !== null}
        >
          <DialogPrimitive.Title className="text-lg font-semibold tracking-[-0.02em]">
            {t('providerRecovery.title')}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-2 text-sm text-muted-foreground">
            {t('providerRecovery.description')}
          </DialogPrimitive.Description>
          <div className="mt-4 space-y-2">
            <p className="text-xs text-muted-foreground">{t('providerRecovery.backupDirectory')}</p>
            <p className="select-text break-all rounded-lg border border-border bg-card p-3 font-mono text-xs">
              {recovery?.backupDirectory}
            </p>
            <Button variant="link" size="sm" disabled={pending !== null} onClick={() => void openBackup()}>
              {t('providerRecovery.openBackup')}
            </Button>
          </div>
          {error && <p role="alert" className="mt-3 text-sm text-destructive">{t(`providerRecovery.${error}`)}</p>}
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" disabled={pending !== null} onClick={() => void acknowledge(false)}>
              {t('providerRecovery.acknowledge')}
            </Button>
            <Button disabled={pending !== null} onClick={() => void acknowledge(true)}>
              {t('providerModels.actions.add')}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
