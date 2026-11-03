import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { SettingsSectionProps } from '@/app/extensions';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { invokeIpc } from '@/lib/api-client';
import type { GraphicsChangeResult, GraphicsSettingsState } from '@/types/desktop/graphics';

export default function GraphicsAccelerationSetting({ active }: SettingsSectionProps) {
  const { t } = useTranslation('settings');
  const id = useId();
  const [state, setState] = useState<GraphicsSettingsState | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  const [requestedEnabled, setRequestedEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void invokeIpc<GraphicsSettingsState>('app:graphics-status').then(
      (result) => {
        if (!cancelled) {
          setState(result);
          setReadFailed(false);
        }
      },
      () => {
        if (!cancelled) {
          setState(null);
          setReadFailed(true);
        }
      },
    );
    return () => { cancelled = true; };
  }, [active, readAttempt]);

  const confirmChange = async () => {
    if (pending || requestedEnabled === null) return;
    setPending(true);
    try {
      const result = await invokeIpc<GraphicsChangeResult>('app:set-graphics-acceleration', requestedEnabled);
      if (result.status === 'restarting') {
        setRequestedEnabled(null);
        return;
      }
      if (result.status === 'blocked') {
        toast.error(t(`graphicsAcceleration.blocked.${result.reason}`));
      } else {
        setState((current) => current ? { ...current, enabled: requestedEnabled } : current);
      }
    } catch {
      toast.error(t('graphicsAcceleration.changeFailed'));
    }
    setPending(false);
    setRequestedEnabled(null);
  };

  if (!active || state?.supported === false) return null;

  return (
    <>
      <Separator />
      <div className="flex items-center justify-between gap-4" aria-busy={pending}>
        <div className="space-y-1">
          <Label htmlFor={id}>{t('graphicsAcceleration.label')}</Label>
          <p id={`${id}-description`} className="text-sm text-muted-foreground">
            {t('graphicsAcceleration.description')}
          </p>
          {state?.automaticallyDisabled && (
            <p id={`${id}-reason`} className="text-sm text-muted-foreground">
              {t('graphicsAcceleration.automaticallyDisabled')}
            </p>
          )}
          {readFailed && (
            <p role="alert" className="text-sm text-muted-foreground">
              {t('graphicsAcceleration.readFailed')}
            </p>
          )}
        </div>
        {state ? (
          <Switch
            id={id}
            checked={state.enabled}
            disabled={pending || requestedEnabled !== null}
            aria-describedby={`${id}-description${state.automaticallyDisabled ? ` ${id}-reason` : ''}`}
            onCheckedChange={setRequestedEnabled}
          />
        ) : readFailed ? (
          <Button type="button" variant="outline" size="sm" onClick={() => {
            setReadFailed(false);
            setReadAttempt((value) => value + 1);
          }}>
            {t('graphicsAcceleration.retry')}
          </Button>
        ) : (
          <span role="status" className="shrink-0 text-sm text-muted-foreground">
            {t('graphicsAcceleration.loading')}
          </span>
        )}
      </div>
      <ConfirmDialog
        open={requestedEnabled !== null}
        title={t('graphicsAcceleration.confirmTitle')}
        message={t(requestedEnabled ? 'graphicsAcceleration.confirmEnable' : 'graphicsAcceleration.confirmDisable')}
        confirmLabel={t(pending ? 'graphicsAcceleration.pending' : 'graphicsAcceleration.confirmAction')}
        cancelLabel={t('graphicsAcceleration.cancel')}
        onConfirm={confirmChange}
        onCancel={() => { if (!pending) setRequestedEnabled(null); }}
      />
    </>
  );
}
