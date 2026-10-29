import { useCallback, useMemo, Suspense } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useContributions } from '@/plugin-host/react';
import { hostSecurityApplyRemediation, hostSecurityPreviewRemediation, hostSecurityRollbackRemediation } from './security-runtime';
import { useSecuritySupportStore, type RemediationActionItem } from './security-support-store';
import { securityChecks, type SecuritySectionProps } from './extensions';

export function ActionCenterSection({ policyControlsDisabled, gatewayOperational, gatewayPreparing }: SecuritySectionProps) {
  const { t } = useTranslation('security');
  const securityOpBusy = useSecuritySupportStore((state) => state.securityOpBusy);
  const securityOpResult = useSecuritySupportStore((state) => state.securityOpResult);
  const remediationActions = useSecuritySupportStore((state) => state.remediationActions);
  const selectedRemediationActions = useSecuritySupportStore((state) => state.selectedRemediationActions);
  const lastRemediationSnapshotId = useSecuritySupportStore((state) => state.lastRemediationSnapshotId);
  const setSecurityOpBusy = useSecuritySupportStore((state) => state.setSecurityOpBusy);
  const setSecurityOpResult = useSecuritySupportStore((state) => state.setSecurityOpResult);
  const setRemediationActions = useSecuritySupportStore((state) => state.setRemediationActions);
  const setSelectedRemediationActions = useSecuritySupportStore((state) => state.setSelectedRemediationActions);
  const setLastRemediationSnapshotId = useSecuritySupportStore((state) => state.setLastRemediationSnapshotId);
  const contributions = useContributions(securityChecks);
  const checks = useMemo(() => [...contributions].sort((a, b) => a.order - b.order), [contributions]);
  const runSecurityOp = useCallback(async <T,>(
    name: string,
    runner: () => Promise<T>,
    consumeResult?: (result: T) => { display: string; success: boolean; message?: string },
  ) => {
    if (!gatewayOperational) {
      toast.error(gatewayPreparing ? t('actionCenter.gatewayPreparing') : t('actionCenter.gatewayNotRunning'));
      return;
    }
    setSecurityOpBusy(name);
    try {
      const result = await runner();
      const consumed = consumeResult?.(result);
      setSecurityOpResult(consumed?.display ?? JSON.stringify(result, null, 2));
      if (consumed?.success === false) {
        toast.error(consumed.message ?? t('actionCenter.runFailed', { name }));
      } else {
        toast.success(t('actionCenter.runSuccess', { name }));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSecurityOpResult(`ERROR: ${message}`);
      toast.error(t('actionCenter.runFailed', { name }));
    } finally {
      setSecurityOpBusy(null);
    }
  }, [gatewayOperational, gatewayPreparing, setSecurityOpBusy, setSecurityOpResult, t]);
  return (
      <Card>
        <CardHeader>
          <CardTitle>{t('actionCenter.title')}</CardTitle>
          <CardDescription>{t('actionCenter.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Suspense fallback={<p className="text-sm text-muted-foreground">{t('loading')}</p>}>
              {checks.map(({ id, component: Check }) => (
                <Check key={id} disabled={securityOpBusy !== null || !gatewayOperational} runSecurityOp={runSecurityOp} />
              ))}
            </Suspense>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={securityOpBusy !== null || !gatewayOperational} onClick={() => void runSecurityOp(t('actionCenter.remediationPreview'), async () => {
              const payload = await hostSecurityPreviewRemediation<{ actions?: RemediationActionItem[] }>();
              const actions = Array.isArray(payload.actions) ? payload.actions : [];
              setRemediationActions(actions);
              return payload;
            })}>{t('actionCenter.remediationPreview')}</Button>
            <Button disabled={securityOpBusy !== null || !gatewayOperational || selectedRemediationActions.length === 0} onClick={() => void runSecurityOp(t('actionCenter.remediationApply'), async () => {
              const payload = await hostSecurityApplyRemediation<{ snapshotId?: string }>(selectedRemediationActions);
              if (payload.snapshotId) setLastRemediationSnapshotId(payload.snapshotId);
              return payload;
            })}>{t('actionCenter.remediationApply')}</Button>
            <Button variant="outline" disabled={securityOpBusy !== null || !gatewayOperational} onClick={() => void runSecurityOp(t('actionCenter.remediationRollback'), async () => await hostSecurityRollbackRemediation(lastRemediationSnapshotId))}>{t('actionCenter.remediationRollback')}</Button>
          </div>

          {remediationActions.length > 0 && (
            <div className="space-y-2 rounded-md border p-3">
              {remediationActions.map((item) => (
                <label key={item.id} className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" disabled={policyControlsDisabled} checked={selectedRemediationActions.includes(item.id)} onChange={(e) => setSelectedRemediationActions((prev) => (e.target.checked ? [...prev, item.id] : prev.filter((id) => id !== item.id)))} />
                  <span><span className="font-medium">{item.title}</span><span className="ml-2 text-xs text-muted-foreground">[{item.risk}]</span><p className="text-xs text-muted-foreground">{item.description}</p></span>
                </label>
              ))}
            </div>
          )}

          {securityOpResult && <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-2 text-xs">{securityOpResult}</pre>}
        </CardContent>
      </Card>
  );
}
