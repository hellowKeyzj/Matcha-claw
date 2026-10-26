import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useSecurityPolicyStore } from './security-policy-store';
import type { Action, FailureMode, Preset, RuntimePolicy, Severity } from './security-policy-store';
import type { SecuritySectionProps } from './extensions';
import { parsePolicyList } from './policy-fields';

const DESTRUCTIVE_ACTIONS: Action[] = ['block', 'confirm', 'warn', 'log'];
const SECRET_ACTIONS: Action[] = ['block', 'redact', 'confirm', 'warn', 'log'];
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];

export function RuntimeSection({ policyControlsDisabled }: SecuritySectionProps) {
  const { t } = useTranslation('security');
  const policy = useSecurityPolicyStore((state) => state.policy);
  const updateRuntime = useSecurityPolicyStore((state) => state.updateRuntime);
  const applyPresetTemplate = useSecurityPolicyStore((state) => state.applyPresetTemplate);
  const runtime = policy.runtime;
  return (
      <Card>
        <CardHeader><CardTitle>{t('runtime.title')}</CardTitle><CardDescription>{t('runtime.description')}</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2 rounded-md border p-3">
            <Label htmlFor="security-preset">{t('runtimePreset.mode')}</Label>
            <Select
              id="security-preset"
              value={policy.preset}
              disabled={policyControlsDisabled}
              onChange={(e) => applyPresetTemplate(e.target.value as Preset)}
            >
              <option value="strict">{t('preset.strict')}</option>
              <option value="balanced">{t('preset.balanced')}</option>
              <option value="relaxed">{t('preset.relaxed')}</option>
            </Select>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{t('runtime.runtimeGuardEnabled')}</span><Switch disabled={policyControlsDisabled} checked={runtime.runtimeGuardEnabled} onCheckedChange={(checked) => updateRuntime((current) => ({ ...current, runtimeGuardEnabled: checked }))} /></label>
            <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{t('runtime.auditOnGatewayStart')}</span><Switch disabled={policyControlsDisabled} checked={runtime.auditOnGatewayStart} onCheckedChange={(checked) => updateRuntime((current) => ({ ...current, auditOnGatewayStart: checked }))} /></label>
            <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{t('runtime.autoHarden')}</span><Switch disabled={policyControlsDisabled} checked={runtime.autoHarden} onCheckedChange={(checked) => updateRuntime((current) => ({ ...current, autoHarden: checked }))} /></label>
            <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{t('runtime.blockDestructive')}</span><Switch disabled={policyControlsDisabled} checked={runtime.blockDestructive} onCheckedChange={(checked) => updateRuntime((current) => ({ ...current, blockDestructive: checked }))} /></label>
            <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{t('runtime.blockSecrets')}</span><Switch disabled={policyControlsDisabled} checked={runtime.blockSecrets} onCheckedChange={(checked) => updateRuntime((current) => ({ ...current, blockSecrets: checked }))} /></label>
            <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{t('runtime.enablePromptInjectionGuard')}</span><Switch disabled={policyControlsDisabled} checked={runtime.enablePromptInjectionGuard} onCheckedChange={(checked) => updateRuntime((current) => ({ ...current, enablePromptInjectionGuard: checked }))} /></label>
            <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{t('runtime.logDetections')}</span><Switch disabled={policyControlsDisabled} checked={runtime.logging.logDetections} onCheckedChange={(checked) => updateRuntime((current) => ({ ...current, logging: { ...current.logging, logDetections: checked } }))} /></label>
          </div>
        </CardContent>
      </Card>
  );
}

export function MatrixSection({ policyControlsDisabled }: SecuritySectionProps) {
  const { t } = useTranslation('security');
  const runtime = useSecurityPolicyStore((state) => state.policy.runtime);
  const updateRuntime = useSecurityPolicyStore((state) => state.updateRuntime);
  const getActionLabel = (action: Action) => t(`matrix.action.${action}`);
  const getSeverityLabel = (severity: Severity) => t(`matrix.severity.${severity}`);
  const getCategoryLabel = (key: keyof RuntimePolicy['destructive']['categories']) => t(`matrix.category.${key}`);
  const toggleCategory = (key: keyof RuntimePolicy['destructive']['categories'], checked: boolean) => {
    updateRuntime((current) => ({
      ...current,
      destructive: {
        ...current.destructive,
        categories: { ...current.destructive.categories, [key]: checked },
      },
    }));
  };
  return (
      <>
      <Card>
        <CardHeader><CardTitle>{t('matrix.title')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div><Label>{t('matrix.destructiveDefaultAction')}</Label><Select disabled={policyControlsDisabled} value={runtime.destructive.action} onChange={(e) => updateRuntime((current) => ({ ...current, destructive: { ...current.destructive, action: e.target.value as Action } }))}>{DESTRUCTIVE_ACTIONS.map((action) => <option key={`destructive-${action}`} value={action}>{getActionLabel(action)}</option>)}</Select></div>
            <div><Label>{t('matrix.secretsDefaultAction')}</Label><Select disabled={policyControlsDisabled} value={runtime.secrets.action} onChange={(e) => updateRuntime((current) => ({ ...current, secrets: { ...current.secrets, action: e.target.value as Action } }))}>{SECRET_ACTIONS.map((action) => <option key={`secrets-${action}`} value={action}>{getActionLabel(action)}</option>)}</Select></div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t('matrix.destructiveBySeverity')}</p>
              {SEVERITIES.map((severity) => (
                <div key={`d-${severity}`} className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-2">
                  <Label className="min-w-0 truncate">{getSeverityLabel(severity)}</Label>
                  <Select
                    className="w-[120px]"
                    disabled={policyControlsDisabled}
                    value={runtime.destructive.severityActions[severity]}
                    onChange={(e) => updateRuntime((current) => ({
                      ...current,
                      destructive: {
                        ...current.destructive,
                        severityActions: {
                          ...current.destructive.severityActions,
                          [severity]: e.target.value as Action,
                        },
                      },
                    }))}
                  >
                    {DESTRUCTIVE_ACTIONS.map((action) => (
                      <option key={`d-${severity}-${action}`} value={action}>{getActionLabel(action)}</option>
                    ))}
                  </Select>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t('matrix.secretsBySeverity')}</p>
              {SEVERITIES.map((severity) => (
                <div key={`s-${severity}`} className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-2">
                  <Label className="min-w-0 truncate">{getSeverityLabel(severity)}</Label>
                  <Select
                    className="w-[120px]"
                    disabled={policyControlsDisabled}
                    value={runtime.secrets.severityActions[severity]}
                    onChange={(e) => updateRuntime((current) => ({
                      ...current,
                      secrets: {
                        ...current.secrets,
                        severityActions: {
                          ...current.secrets.severityActions,
                          [severity]: e.target.value as Action,
                        },
                      },
                    }))}
                  >
                    {SECRET_ACTIONS.map((action) => (
                      <option key={`s-${severity}-${action}`} value={action}>{getActionLabel(action)}</option>
                    ))}
                  </Select>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('matrix.destructiveCategoryTitle')}</CardTitle></CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-2">
          <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{getCategoryLabel('fileDelete')}</span><Switch disabled={policyControlsDisabled} checked={runtime.destructive.categories.fileDelete} onCheckedChange={(checked) => toggleCategory('fileDelete', checked)} /></label>
          <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{getCategoryLabel('gitDestructive')}</span><Switch disabled={policyControlsDisabled} checked={runtime.destructive.categories.gitDestructive} onCheckedChange={(checked) => toggleCategory('gitDestructive', checked)} /></label>
          <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{getCategoryLabel('sqlDestructive')}</span><Switch disabled={policyControlsDisabled} checked={runtime.destructive.categories.sqlDestructive} onCheckedChange={(checked) => toggleCategory('sqlDestructive', checked)} /></label>
          <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{getCategoryLabel('systemDestructive')}</span><Switch disabled={policyControlsDisabled} checked={runtime.destructive.categories.systemDestructive} onCheckedChange={(checked) => toggleCategory('systemDestructive', checked)} /></label>
          <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{getCategoryLabel('processKill')}</span><Switch disabled={policyControlsDisabled} checked={runtime.destructive.categories.processKill} onCheckedChange={(checked) => toggleCategory('processKill', checked)} /></label>
          <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{getCategoryLabel('networkDestructive')}</span><Switch disabled={policyControlsDisabled} checked={runtime.destructive.categories.networkDestructive} onCheckedChange={(checked) => toggleCategory('networkDestructive', checked)} /></label>
          <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{getCategoryLabel('privilegeEscalation')}</span><Switch disabled={policyControlsDisabled} checked={runtime.destructive.categories.privilegeEscalation} onCheckedChange={(checked) => toggleCategory('privilegeEscalation', checked)} /></label>
        </CardContent>
      </Card>
      </>
  );
}

export function PolicyGuardsSection({ policyControlsDisabled }: SecuritySectionProps) {
  const { t } = useTranslation('security');
  const runtime = useSecurityPolicyStore((state) => state.policy.runtime);
  const updateRuntime = useSecurityPolicyStore((state) => state.updateRuntime);
  return (
      <Card>
        <CardHeader>
          <CardTitle>{t('policyGuards.title')}</CardTitle>
          <CardDescription>{t('policyGuards.description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label>{t('policyGuards.labels.allowPathPrefixes')}</Label>
            <Textarea
              disabled={policyControlsDisabled}
              rows={6}
              value={runtime.allowPathPrefixes.join(', ')}
              onChange={(e) => updateRuntime((current) => ({ ...current, allowPathPrefixes: parsePolicyList(e.target.value) }))}
            />
          </div>
          <div className="space-y-1">
            <Label>{t('policyGuards.labels.allowDomains')}</Label>
            <Textarea
              disabled={policyControlsDisabled}
              rows={6}
              value={runtime.allowDomains.join(', ')}
              onChange={(e) => updateRuntime((current) => ({ ...current, allowDomains: parsePolicyList(e.target.value) }))}
            />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>{t('policyGuards.labels.auditEgressAllowlist')}</Label>
            <Textarea
              disabled={policyControlsDisabled}
              rows={4}
              value={runtime.auditEgressAllowlist.join(', ')}
              onChange={(e) => updateRuntime((current) => ({ ...current, auditEgressAllowlist: parsePolicyList(e.target.value) }))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="auditDailyCostLimitUsd">{t('policyGuards.labels.auditDailyCostLimitUsd')}</Label>
            <input
              id="auditDailyCostLimitUsd"
              type="number"
              min={0.01}
              step={0.01}
              value={runtime.auditDailyCostLimitUsd}
              disabled={policyControlsDisabled}
              onChange={(e) => updateRuntime((current) => ({
                ...current,
                auditDailyCostLimitUsd: Number.isFinite(Number(e.target.value)) && Number(e.target.value) > 0
                  ? Number(e.target.value)
                  : current.auditDailyCostLimitUsd,
              }))}
              className="h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="auditFailureMode">{t('policyGuards.labels.auditFailureMode')}</Label>
            <Select
              id="auditFailureMode"
              value={runtime.auditFailureMode ?? ''}
              disabled={policyControlsDisabled}
              onChange={(e) => updateRuntime((current) => ({
                ...current,
                auditFailureMode: e.target.value === '' ? null : e.target.value as Exclude<FailureMode, null>,
              }))}
            >
              <option value="">{t('policyGuards.failureMode.unset')}</option>
              <option value="block_all">{t('policyGuards.failureMode.block_all')}</option>
              <option value="safe_mode">{t('policyGuards.failureMode.safe_mode')}</option>
              <option value="read_only">{t('policyGuards.failureMode.read_only')}</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{t('policyGuards.labels.promptInjectionPatterns')}</Label>
            <Textarea
              disabled={policyControlsDisabled}
              rows={6}
              value={runtime.promptInjectionPatterns.join(', ')}
              onChange={(e) => updateRuntime((current) => ({ ...current, promptInjectionPatterns: parsePolicyList(e.target.value) }))}
            />
          </div>
        </CardContent>
      </Card>
  );
}
