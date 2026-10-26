import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useSecuritySupportStore } from './security-support-store';
import type { SecuritySectionProps } from './extensions';

export function AuditHitsSection({ gatewayOperational, gatewayPreparing, gatewayProcessState }: SecuritySectionProps) {
  const { t } = useTranslation('security');
  const auditItems = useSecuritySupportStore((state) => state.auditItems);
  const loadingAudit = useSecuritySupportStore((state) => state.loadingAudit);
  const auditError = useSecuritySupportStore((state) => state.auditError);
  const auditStale = useSecuritySupportStore((state) => state.auditStale);
  const loadRecentAudits = useSecuritySupportStore((state) => state.loadRecentAudits);
  const localizeAuditRisk = useCallback((risk: string): string => (
    t(`audit.risk.${risk}`, { defaultValue: risk })
  ), [t]);

  const localizeAuditAction = useCallback((action: string): string => (
    t(`audit.action.${action}`, { defaultValue: action })
  ), [t]);
  return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div><CardTitle>{t('audit.title')}</CardTitle><CardDescription>{t('audit.description')}</CardDescription></div>
          <Button variant="outline" size="sm" onClick={() => void loadRecentAudits({ gatewayProcessState, page: 1, pageSize: 8 })}>{t('audit.refresh')}</Button>
        </CardHeader>
        <CardContent>
          {!gatewayOperational ? <p className="text-sm text-muted-foreground">{gatewayPreparing ? t('audit.gatewayPreparing') : t('audit.gatewayStopped')}</p> : loadingAudit ? <p className="text-sm text-muted-foreground">{t('audit.loading')}</p> : auditError ? (
            <div className="space-y-1 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              <p>{t('audit.loadFailed')}</p>
              <p className="text-xs">{auditError.startsWith('errors.') ? t(auditError) : auditError}</p>
              {auditStale && <p className="text-xs">{t('audit.stale')}</p>}
            </div>
          ) : auditItems.length === 0 ? <p className="text-sm text-muted-foreground">{t('audit.empty')}</p> : (
            <div className="space-y-2">
              {auditItems.map((item, index) => (
                <div key={`${item.ts}-${index}`} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-medium">{item.toolName || '-'}</div>
                    <div className="flex items-center gap-2"><Badge variant="outline">{localizeAuditRisk(item.risk)}</Badge><Badge variant="outline">{localizeAuditAction(item.action)}</Badge></div>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{new Date(item.ts).toLocaleString()} · {t('audit.ruleLabel')}: {item.ruleId || '-'} · {t('audit.decisionLabel')}: {item.decision || '-'}</div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
  );
}
