import { useCallback, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  hostSecurityApplyRemediation,
  hostSecurityCheckAdvisories,
  hostSecurityCheckIntegrity,
  hostSecurityPreviewRemediation,
  hostSecurityRebaselineIntegrity,
  hostSecurityRollbackRemediation,
  hostSecurityRunEmergencyResponse,
  hostSecurityRunQuickAudit,
  hostSecurityScanSkills,
} from '@/lib/security-runtime';
import { useGatewayStore } from '@/stores/gateway';
import { useSecurityPolicyStore } from '@/stores/security-policy-store';
import { useDelayedFlag } from '@/lib/use-delayed-flag';
import {
  useSecuritySupportStore,
  type AuditItem,
  type AllowlistRegexTab,
  type PlatformTool,
  type RemediationActionItem,
  type RuleCatalogPlatform,
  type SecuritySectionKey,
} from '@/stores/security-support-store';
import { useTranslation } from 'react-i18next';

type Preset = 'strict' | 'balanced' | 'relaxed';
type Action = 'block' | 'redact' | 'confirm' | 'warn' | 'log';
type Severity = 'critical' | 'high' | 'medium' | 'low';
type FailureMode = 'block_all' | 'safe_mode' | 'read_only' | null;

type RuntimePolicy = {
  runtimeGuardEnabled: boolean;
  auditOnGatewayStart: boolean;
  autoHarden: boolean;
  enablePromptInjectionGuard: boolean;
  blockDestructive: boolean;
  blockSecrets: boolean;
  monitors: { credentials: boolean; memory: boolean; cost: boolean };
  logging: { logDetections: boolean };
  allowPathPrefixes: string[];
  allowDomains: string[];
  auditEgressAllowlist: string[];
  auditDailyCostLimitUsd: number;
  auditFailureMode: FailureMode;
  promptInjectionPatterns: string[];
  allowlist: { tools: string[]; sessions: string[] };
  destructive: {
    action: Action;
    severityActions: Record<Severity, Action>;
    categories: {
      fileDelete: boolean;
      gitDestructive: boolean;
      sqlDestructive: boolean;
      systemDestructive: boolean;
      processKill: boolean;
      networkDestructive: boolean;
      privilegeEscalation: boolean;
    };
  };
  secrets: {
    action: Action;
    severityActions: Record<Severity, Action>;
  };
  destructivePatterns: string[];
  secretPatterns: string[];
};

const DESTRUCTIVE_ACTIONS: Action[] = ['block', 'confirm', 'warn', 'log'];
const SECRET_ACTIONS: Action[] = ['block', 'redact', 'confirm', 'warn', 'log'];
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];

const RULE_CATALOG_REASON_KEY_MAP: Record<string, string> = {
  '递归强删目录树': 'recursive_force_delete_tree',
  '终止进程（-9 提升风险）': 'process_kill_with_signal',
  '系统关机/重启': 'system_shutdown_reboot',
  '磁盘/分区破坏': 'disk_partition_destruction',
  '路由表变更（flush 为 critical）': 'route_change_flush_critical',
  '提权执行命令': 'privilege_escalation_command',
  '防火墙策略改动': 'firewall_policy_change',
  '防火墙策略变更': 'firewall_policy_change',
  '递归权限改动可能破坏系统': 'recursive_permission_change_system',
  '系统服务停用（关键服务为 critical）': 'system_service_disable_critical',
  '服务停用（关键服务为 critical）': 'system_service_disable_critical',
  '递归删除目录树': 'recursive_directory_delete',
  '强制/递归删除文件': 'forced_recursive_file_delete',
  '终止进程（/f 提升风险）': 'taskkill_force_risk',
  '删除注册表键值': 'registry_delete',
  '磁盘分区破坏': 'diskpart_destruction',
  '防火墙重置': 'firewall_reset',
  '路由表变更': 'route_change',
  '递归 ACL 改动': 'recursive_acl_change',
  '接管系统文件所有权': 'take_ownership_system_files',
  '服务停用/删除': 'service_disable_or_delete',
  '磁盘抹除/重分区': 'disk_erase_repartition',
  '系统/用户服务停用': 'launchctl_service_disable',
  '关闭 SIP 保护': 'disable_sip',
  '启停 PF 规则': 'pf_toggle',
  '重载 PF 规则文件': 'pf_reload',
  '防火墙规则变更': 'firewall_rule_change',
  '强制终止进程': 'force_kill_process',
};

const RULE_CATALOG_COMMAND_TOKEN_KEY_MAP: Record<string, string> = {
  '系统路径': 'system_path',
  '关键服务 critical': 'critical_service',
  'flush 为 critical': 'flush_is_critical',
};

function list(text: string): string[] {
  return [...new Set(text.split(/[\n,]/g).map((v) => v.trim()).filter(Boolean))];
}

function text(items: string[]): string {
  return items.join(', ');
}

function normalizeRuleReasonText(reason: string): string {
  return reason
    .trim()
    .replaceAll('（', '(')
    .replaceAll('）', ')')
    .replace(/\s+/g, ' ');
}

export function SecurityPage() {
  const { t, i18n } = useTranslation('security');
  const gatewayState = useGatewayStore((state) => state.status.state);

  const policyReady = useSecurityPolicyStore((state) => state.policyReady);
  const initialLoading = useSecurityPolicyStore((state) => state.initialLoading);
  const refreshing = useSecurityPolicyStore((state) => state.refreshing);
  const saving = useSecurityPolicyStore((state) => state.mutating);
  const policy = useSecurityPolicyStore((state) => state.policy);
  const savedPolicySnapshot = useSecurityPolicyStore((state) => state.savedPolicySnapshot);
  const policyError = useSecurityPolicyStore((state) => state.error);
  const updateRuntime = useSecurityPolicyStore((state) => state.updateRuntime);
  const applyPresetTemplate = useSecurityPolicyStore((state) => state.applyPresetTemplate);
  const loadPolicy = useSecurityPolicyStore((state) => state.loadPolicy);
  const savePolicy = useSecurityPolicyStore((state) => state.savePolicy);
  const auditItems = useSecuritySupportStore((state) => state.auditItems);
  const loadingAudit = useSecuritySupportStore((state) => state.loadingAudit);
  const platformTools = useSecuritySupportStore((state) => state.platformTools);
  const loadingPlatformTools = useSecuritySupportStore((state) => state.loadingPlatformTools);
  const platformToolsError = useSecuritySupportStore((state) => state.platformToolsError);
  const platformToolsHydrated = useSecuritySupportStore((state) => state.platformToolsHydrated);
  const ruleCatalog = useSecuritySupportStore((state) => state.ruleCatalog);
  const loadingRuleCatalog = useSecuritySupportStore((state) => state.loadingRuleCatalog);
  const ruleCatalogError = useSecuritySupportStore((state) => state.ruleCatalogError);
  const loadPlatformTools = useSecuritySupportStore((state) => state.loadPlatformTools);
  const loadRuleCatalog = useSecuritySupportStore((state) => state.loadRuleCatalog);
  const loadRecentAudits = useSecuritySupportStore((state) => state.loadRecentAudits);
  const securityOpBusy = useSecuritySupportStore((state) => state.securityOpBusy);
  const securityOpResult = useSecuritySupportStore((state) => state.securityOpResult);
  const remediationActions = useSecuritySupportStore((state) => state.remediationActions);
  const selectedRemediationActions = useSecuritySupportStore((state) => state.selectedRemediationActions);
  const lastRemediationSnapshotId = useSecuritySupportStore((state) => state.lastRemediationSnapshotId);
  const allowlistRegexTab = useSecuritySupportStore((state) => state.allowlistRegexTab);
  const ruleCatalogPlatform = useSecuritySupportStore((state) => state.ruleCatalogPlatform);
  const activeSection = useSecuritySupportStore((state) => state.activeSection);
  const setSecurityOpBusy = useSecuritySupportStore((state) => state.setSecurityOpBusy);
  const setSecurityOpResult = useSecuritySupportStore((state) => state.setSecurityOpResult);
  const setRemediationActions = useSecuritySupportStore((state) => state.setRemediationActions);
  const setSelectedRemediationActions = useSecuritySupportStore((state) => state.setSelectedRemediationActions);
  const setLastRemediationSnapshotId = useSecuritySupportStore((state) => state.setLastRemediationSnapshotId);
  const setAllowlistRegexTab = useSecuritySupportStore((state) => state.setAllowlistRegexTab);
  const setRuleCatalogPlatform = useSecuritySupportStore((state) => state.setRuleCatalogPlatform);
  const setActiveSection = useSecuritySupportStore((state) => state.setActiveSection);
  const showPolicyRefreshingHint = useDelayedFlag(refreshing, 180);

  const getActionLabel = useCallback((action: Action) => t(`matrix.action.${action}`), [t]);
  const getSeverityLabel = useCallback((severity: Severity) => t(`matrix.severity.${severity}`), [t]);
  const getCategoryLabel = useCallback(
    (key: keyof RuntimePolicy['destructive']['categories']) => t(`matrix.category.${key}`),
    [t],
  );

  useEffect(() => {
    void loadPolicy({ silent: true });
  }, [loadPolicy]);

  const handleSavePolicy = useCallback(async () => {
    try {
      await savePolicy();
      toast.success(t('messages.saved'));
    } catch {
      toast.error(t('messages.saveFailed'));
    }
  }, [savePolicy, t]);

  useEffect(() => {
    void loadRecentAudits({ gatewayState, page: 1, pageSize: 8 });
  }, [gatewayState, loadRecentAudits]);

  useEffect(() => {
    if (activeSection !== 'allowlistRegex') return;
    if (platformToolsHydrated) return;
    void loadPlatformTools({ refresh: false });
  }, [activeSection, loadPlatformTools, platformToolsHydrated]);

  useEffect(() => {
    void loadRuleCatalog();
  }, [loadRuleCatalog]);

  const runSecurityOp = useCallback(async (name: string, runner: () => Promise<unknown>) => {
    if (gatewayState !== 'running') {
      toast.error(t('actionCenter.gatewayNotRunning'));
      return;
    }
    setSecurityOpBusy(name);
    try {
      const result = await runner();
      setSecurityOpResult(JSON.stringify(result, null, 2));
      toast.success(t('actionCenter.runSuccess', { name }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSecurityOpResult(`ERROR: ${message}`);
      toast.error(t('actionCenter.runFailed', { name }));
    } finally {
      setSecurityOpBusy(null);
    }
  }, [gatewayState, setSecurityOpBusy, setSecurityOpResult, t]);

  const runtime = policy.runtime;
  const isDirty = useMemo(
    () => JSON.stringify(policy) !== JSON.stringify(savedPolicySnapshot),
    [policy, savedPolicySnapshot],
  );
  const selectedToolCount = runtime.allowlist.tools.length;
  const selectedToolSet = new Set(runtime.allowlist.tools);
  const enabledPlatformToolIds = platformTools
    .filter((tool) => tool.enabled !== false)
    .map((tool) => tool.id);
  const displayedRuleCatalog = ruleCatalog
    .filter((item) => ruleCatalogPlatform === 'all' ? true : item.platform === ruleCatalogPlatform || item.platform === 'universal')
    .sort((a, b) => {
      if (a.platform === b.platform) return a.command.localeCompare(b.command);
      return a.platform.localeCompare(b.platform);
    });
  const sectionItems: Array<{ key: SecuritySectionKey; label: string }> = [
    { key: 'runtime', label: t('sections.runtime') },
    { key: 'matrix', label: t('sections.matrix') },
    { key: 'ruleCatalog', label: t('sections.ruleCatalog') },
    { key: 'allowlistRegex', label: t('sections.allowlistRegex') },
    { key: 'policyGuards', label: t('sections.policyGuards') },
    { key: 'actionCenter', label: t('sections.actionCenter') },
    { key: 'auditHits', label: t('sections.auditHits') },
  ];

  const updateAllowlistTools = (nextTools: string[]) => {
    const deduped = [...new Set(nextTools.map((item) => item.trim()).filter(Boolean))];
    updateRuntime((current) => ({
      ...current,
      allowlist: { ...current.allowlist, tools: deduped },
    }));
  };

  const toggleAllowlistTool = (toolId: string) => {
    if (selectedToolSet.has(toolId)) {
      updateAllowlistTools(runtime.allowlist.tools.filter((item) => item !== toolId));
      return;
    }
    updateAllowlistTools([...runtime.allowlist.tools, toolId]);
  };

  const toggleCategory = (key: keyof RuntimePolicy['destructive']['categories'], checked: boolean) => {
    updateRuntime((current) => ({
      ...current,
      destructive: {
        ...current.destructive,
        categories: { ...current.destructive.categories, [key]: checked },
      },
    }));
  };

  const localizeAuditDetail = useCallback((item: AuditItem): string => {
    if (!item.detail) return '';
    if (item.ruleId === 'SC-SKILL-001') {
      const matched = item.detail.match(/^(\d+)\s+skill\(s\)\s+installed$/i);
      if (matched) {
        const count = Number(matched[1]);
        return t('audit.findings.SC-SKILL-001', { count, defaultValue: item.detail });
      }
    }
    if (item.ruleId) {
      return t(`audit.findings.${item.ruleId}`, { defaultValue: item.detail });
    }
    return item.detail;
  }, [t]);

  const localizeRuleCatalogPlatform = useCallback((platform: string): string => (
    t(`ruleCatalog.platform.${platform}`, { defaultValue: platform })
  ), [t]);

  const localizeRuleCatalogCategory = useCallback((category: string): string => (
    t(`ruleCatalog.category.${category}`, { defaultValue: category })
  ), [t]);

  const localizeRuleCatalogSeverity = useCallback((severity: string): string => {
    const parts = severity.split('|').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) {
      return severity;
    }
    return parts
      .map((part) => t(`ruleCatalog.severity.${part}`, { defaultValue: part }))
      .join(' / ');
  }, [t]);

  const localizeRuleCatalogReason = useCallback((reason: string): string => {
    const normalizedReason = normalizeRuleReasonText(reason);
    const candidates = [
      reason,
      normalizedReason,
      reason.replace('系统服务停用', '服务停用'),
      normalizedReason.replace('系统服务停用', '服务停用'),
      reason.replace('服务停用', '系统服务停用'),
      normalizedReason.replace('服务停用', '系统服务停用'),
    ];
    const mappedKey = candidates
      .map((candidate) => RULE_CATALOG_REASON_KEY_MAP[candidate])
      .find((value): value is string => typeof value === 'string' && value.length > 0);
    if (!mappedKey) {
      return reason;
    }
    return t(`ruleCatalog.reason.${mappedKey}`, { defaultValue: reason });
  }, [t]);

  const localizeRuleCatalogCommand = useCallback((command: string): string => {
    let output = command;
    Object.entries(RULE_CATALOG_COMMAND_TOKEN_KEY_MAP).forEach(([token, key]) => {
      const translated = t(`ruleCatalog.commandToken.${key}`, { defaultValue: token });
      output = output
        .replaceAll(`（${token}）`, `(${translated})`)
        .replaceAll(`(${token})`, `(${translated})`);
    });
    return output;
  }, [t]);

  const localizeAuditRisk = useCallback((risk: string): string => (
    t(`audit.risk.${risk}`, { defaultValue: risk })
  ), [t]);

  const localizeAuditAction = useCallback((action: string): string => (
    t(`audit.action.${action}`, { defaultValue: action })
  ), [t]);

  const localizeToolSource = useCallback((source?: string): string => {
    if (!source) return t('allowlistRegex.source.unknown');
    return t(`allowlistRegex.source.${source}`, { defaultValue: source });
  }, [t]);

  const localizeToolDisplayName = useCallback((tool: PlatformTool): string => {
    const localized = t(`toolLabels.${tool.id}`, { defaultValue: '' }).trim();
    if (localized) return localized;
    const rawName = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (rawName) {
      if (i18n.language.toLowerCase().startsWith('zh')) return rawName;
      if (!/[\u3400-\u9FFF]/u.test(rawName)) return rawName;
    }
    return tool.id;
  }, [i18n.language, t]);

  const localizeToolDescription = useCallback((tool: PlatformTool): string => {
    const localized = t(`toolDescriptions.${tool.id}`, { defaultValue: '' }).trim();
    if (localized) return localized;
    const rawDescription = typeof tool.description === 'string' ? tool.description.trim() : '';
    if (!rawDescription) return '';
    if (i18n.language.toLowerCase().startsWith('zh')) return rawDescription;
    return /[\u3400-\u9FFF]/u.test(rawDescription) ? '' : rawDescription;
  }, [i18n.language, t]);

  if (!policyReady && initialLoading) {
    return <section className="space-y-4"><p className="text-sm text-muted-foreground">{t('loading')}</p></section>;
  }

  return (
    <section className="flex flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {showPolicyRefreshingHint && (
            <Badge variant="outline" className="text-xs font-normal">
              {t('loading')}
            </Badge>
          )}
          {isDirty && (
            <Badge variant="outline" className="border-amber-500 text-amber-700">
              {t('page.unsaved')}
            </Badge>
          )}
          <Button onClick={() => void handleSavePolicy()} disabled={saving || !isDirty}>
            {saving ? t('actions.saving') : t('actions.save')}
          </Button>
        </div>
      </header>

      {policyError && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {policyError.startsWith('errors.') ? t(policyError) : policyError}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <Card className="h-fit border-border/60 bg-card/80">
          <CardContent className="p-2.5">
            <nav className="space-y-1" aria-label={t('sections.navAria')}>
              {sectionItems.map((section) => (
                <Button
                  key={section.key}
                  type="button"
                  variant="ghost"
                  className={`h-10 w-full justify-start rounded-lg border border-transparent px-2.5 text-sm font-medium transition-colors ${
                    activeSection === section.key
                      ? 'bg-primary/12 text-primary hover:bg-primary/18'
                      : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'
                  }`}
                  onClick={() => setActiveSection(section.key)}
                >
                  <span
                    aria-hidden
                    className={`mr-2 h-1.5 w-1.5 rounded-full transition-colors ${
                      activeSection === section.key ? 'bg-primary' : 'bg-transparent'
                    }`}
                  />
                  <span className="truncate">{section.label}</span>
                </Button>
              ))}
            </nav>
          </CardContent>
        </Card>

        <div className="space-y-6">

      {activeSection === 'runtime' && (
      <Card>
        <CardHeader><CardTitle>{t('runtime.title')}</CardTitle><CardDescription>{t('runtime.description')}</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2 rounded-md border p-3">
            <Label htmlFor="security-preset">{t('runtimePreset.mode')}</Label>
            <Select
              id="security-preset"
              value={policy.preset}
              onChange={(e) => applyPresetTemplate(e.target.value as Preset)}
            >
              <option value="strict">{t('preset.strict')}</option>
              <option value="balanced">{t('preset.balanced')}</option>
              <option value="relaxed">{t('preset.relaxed')}</option>
            </Select>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{t('runtime.runtimeGuardEnabled')}</span><Switch checked={runtime.runtimeGuardEnabled} onCheckedChange={(checked) => updateRuntime((current) => ({ ...current, runtimeGuardEnabled: checked }))} /></label>
            <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{t('runtime.auditOnGatewayStart')}</span><Switch checked={runtime.auditOnGatewayStart} onCheckedChange={(checked) => updateRuntime((current) => ({ ...current, auditOnGatewayStart: checked }))} /></label>
            <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{t('runtime.autoHarden')}</span><Switch checked={runtime.autoHarden} onCheckedChange={(checked) => updateRuntime((current) => ({ ...current, autoHarden: checked }))} /></label>
            <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{t('runtime.blockDestructive')}</span><Switch checked={runtime.blockDestructive} onCheckedChange={(checked) => updateRuntime((current) => ({ ...current, blockDestructive: checked }))} /></label>
            <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{t('runtime.blockSecrets')}</span><Switch checked={runtime.blockSecrets} onCheckedChange={(checked) => updateRuntime((current) => ({ ...current, blockSecrets: checked }))} /></label>
            <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{t('runtime.enablePromptInjectionGuard')}</span><Switch checked={runtime.enablePromptInjectionGuard} onCheckedChange={(checked) => updateRuntime((current) => ({ ...current, enablePromptInjectionGuard: checked }))} /></label>
            <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{t('runtime.logDetections')}</span><Switch checked={runtime.logging.logDetections} onCheckedChange={(checked) => updateRuntime((current) => ({ ...current, logging: { ...current.logging, logDetections: checked } }))} /></label>
          </div>
        </CardContent>
      </Card>
      )}

      {activeSection === 'matrix' && (
      <>
      <Card>
        <CardHeader><CardTitle>{t('matrix.title')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div><Label>{t('matrix.destructiveDefaultAction')}</Label><Select value={runtime.destructive.action} onChange={(e) => updateRuntime((current) => ({ ...current, destructive: { ...current.destructive, action: e.target.value as Action } }))}>{DESTRUCTIVE_ACTIONS.map((action) => <option key={`destructive-${action}`} value={action}>{getActionLabel(action)}</option>)}</Select></div>
            <div><Label>{t('matrix.secretsDefaultAction')}</Label><Select value={runtime.secrets.action} onChange={(e) => updateRuntime((current) => ({ ...current, secrets: { ...current.secrets, action: e.target.value as Action } }))}>{SECRET_ACTIONS.map((action) => <option key={`secrets-${action}`} value={action}>{getActionLabel(action)}</option>)}</Select></div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t('matrix.destructiveBySeverity')}</p>
              {SEVERITIES.map((severity) => (
                <div key={`d-${severity}`} className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-2">
                  <Label className="min-w-0 truncate">{getSeverityLabel(severity)}</Label>
                  <Select
                    className="w-[120px]"
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
          <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{getCategoryLabel('fileDelete')}</span><Switch checked={runtime.destructive.categories.fileDelete} onCheckedChange={(checked) => toggleCategory('fileDelete', checked)} /></label>
          <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{getCategoryLabel('gitDestructive')}</span><Switch checked={runtime.destructive.categories.gitDestructive} onCheckedChange={(checked) => toggleCategory('gitDestructive', checked)} /></label>
          <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{getCategoryLabel('sqlDestructive')}</span><Switch checked={runtime.destructive.categories.sqlDestructive} onCheckedChange={(checked) => toggleCategory('sqlDestructive', checked)} /></label>
          <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{getCategoryLabel('systemDestructive')}</span><Switch checked={runtime.destructive.categories.systemDestructive} onCheckedChange={(checked) => toggleCategory('systemDestructive', checked)} /></label>
          <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{getCategoryLabel('processKill')}</span><Switch checked={runtime.destructive.categories.processKill} onCheckedChange={(checked) => toggleCategory('processKill', checked)} /></label>
          <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{getCategoryLabel('networkDestructive')}</span><Switch checked={runtime.destructive.categories.networkDestructive} onCheckedChange={(checked) => toggleCategory('networkDestructive', checked)} /></label>
          <label className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{getCategoryLabel('privilegeEscalation')}</span><Switch checked={runtime.destructive.categories.privilegeEscalation} onCheckedChange={(checked) => toggleCategory('privilegeEscalation', checked)} /></label>
        </CardContent>
      </Card>
      </>
      )}

      {activeSection === 'ruleCatalog' && (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>{t('ruleCatalog.title')}</CardTitle>
            <CardDescription>{t('ruleCatalog.description')}</CardDescription>
          </div>
          <Button variant="outline" size="sm" disabled={loadingRuleCatalog} onClick={() => void loadRuleCatalog()}>
            {t('ruleCatalog.refresh')}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-[220px_1fr]">
            <div>
              <Label htmlFor="rule-catalog-platform">{t('ruleCatalog.platformFilter')}</Label>
              <Select
                id="rule-catalog-platform"
                value={ruleCatalogPlatform}
                onChange={(e) => setRuleCatalogPlatform(e.target.value as RuleCatalogPlatform)}
              >
                <option value="all">{t('ruleCatalog.platform.all')}</option>
                <option value="universal">{t('ruleCatalog.platform.universal')}</option>
                <option value="linux">{t('ruleCatalog.platform.linux')}</option>
                <option value="windows">{t('ruleCatalog.platform.windows')}</option>
                <option value="macos">{t('ruleCatalog.platform.macos')}</option>
                <option value="powershell">{t('ruleCatalog.platform.powershell')}</option>
              </Select>
            </div>
            <div className="flex items-end text-xs text-muted-foreground">
              {t('ruleCatalog.count', { count: displayedRuleCatalog.length })}
            </div>
          </div>

          {ruleCatalogError && (
            <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
              {ruleCatalogError.startsWith('errors.') ? t(ruleCatalogError) : ruleCatalogError}
            </p>
          )}

          <div className="max-h-80 overflow-y-auto rounded-md border p-2">
            {loadingRuleCatalog ? (
              <p className="text-xs text-muted-foreground">{t('ruleCatalog.loading')}</p>
            ) : displayedRuleCatalog.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('ruleCatalog.empty')}</p>
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {displayedRuleCatalog.map((item, index) => (
                  <div key={`${item.platform}-${item.command}-${index}`} className="min-w-0 rounded-md border p-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-1">
                      <Badge variant="outline">{localizeRuleCatalogPlatform(item.platform)}</Badge>
                      <Badge variant="outline">{localizeRuleCatalogCategory(item.category)}</Badge>
                      <Badge variant={item.severity.includes('critical') ? 'destructive' : 'outline'}>
                        {localizeRuleCatalogSeverity(item.severity)}
                      </Badge>
                    </div>
                    <p className="mt-2 break-all font-mono text-xs leading-5">{localizeRuleCatalogCommand(item.command)}</p>
                    <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{localizeRuleCatalogReason(item.reason)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      )}

      {activeSection === 'allowlistRegex' && (
      <Card>
        <CardHeader><CardTitle>{t('allowlistRegex.title')}</CardTitle></CardHeader>
        <CardContent>
          <Tabs value={allowlistRegexTab} onValueChange={(value) => setAllowlistRegexTab(value as AllowlistRegexTab)}>
            <TabsList className="grid h-auto w-full grid-cols-2 gap-1 md:grid-cols-4">
              <TabsTrigger value="allowlistTools">{t('allowlistRegex.tabs.allowlistTools')}</TabsTrigger>
              <TabsTrigger value="allowlistSessions">{t('allowlistRegex.tabs.allowlistSessions')}</TabsTrigger>
              <TabsTrigger value="destructivePatterns">{t('allowlistRegex.tabs.destructivePatterns')}</TabsTrigger>
              <TabsTrigger value="secretPatterns">{t('allowlistRegex.tabs.secretPatterns')}</TabsTrigger>
            </TabsList>

            <TabsContent value="allowlistTools" className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t('allowlistRegex.labels.allowlistTools')}</Label>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{t('allowlistRegex.selectedCount', { count: selectedToolCount })}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadingPlatformTools}
                    onClick={() => void loadPlatformTools({ refresh: true })}
                  >
                    {t('allowlistRegex.refresh')}
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={enabledPlatformToolIds.length === 0}
                  onClick={() => updateAllowlistTools(enabledPlatformToolIds)}
                >
                  {t('allowlistRegex.writeEnabledTools')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={selectedToolCount === 0}
                  onClick={() => updateAllowlistTools([])}
                >
                  {t('allowlistRegex.clearSelection')}
                </Button>
              </div>
              {platformToolsError && (
                <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
                  {platformToolsError.startsWith('errors.') ? t(platformToolsError) : platformToolsError}
                </p>
              )}
              <div className="max-h-80 overflow-x-hidden overflow-y-auto rounded-md border p-2">
                {loadingPlatformTools ? (
                  <p className="text-xs text-muted-foreground">{t('allowlistRegex.loadingTools')}</p>
                ) : platformTools.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('allowlistRegex.emptyTools')}</p>
                ) : (
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {platformTools.map((tool) => {
                      const selected = selectedToolSet.has(tool.id);
                      const displayName = localizeToolDisplayName(tool);
                      const displayDescription = localizeToolDescription(tool);
                      return (
                        <button
                          key={tool.id}
                          type="button"
                          onClick={() => toggleAllowlistTool(tool.id)}
                          className={`h-full min-w-0 rounded-md border px-3 py-2 text-left transition ${
                            selected
                              ? 'border-primary bg-primary/10'
                              : 'border-border hover:border-primary/40 hover:bg-muted/30'
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            <span className="min-w-0 flex-1 truncate font-medium">{displayName}</span>
                            <div className="flex max-w-full flex-wrap items-center justify-end gap-1">
                              <Badge variant="outline">{localizeToolSource(tool.source)}</Badge>
                              <Badge variant={tool.enabled === false ? 'destructive' : 'outline'}>
                                {tool.enabled === false ? t('allowlistRegex.status.disabled') : t('allowlistRegex.status.enabled')}
                              </Badge>
                            </div>
                          </div>
                          <p className="mt-1 font-mono text-xs text-muted-foreground">{tool.id}</p>
                          {displayDescription && <p className="mt-1 text-xs text-muted-foreground">{displayDescription}</p>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="allowlistSessions" className="space-y-1">
              <Label>{t('allowlistRegex.labels.allowlistSessions')}</Label>
              <Textarea rows={8} value={text(runtime.allowlist.sessions)} onChange={(e) => updateRuntime((current) => ({ ...current, allowlist: { ...current.allowlist, sessions: list(e.target.value) } }))} />
            </TabsContent>

            <TabsContent value="destructivePatterns" className="space-y-1">
              <Label>{t('allowlistRegex.labels.destructivePatterns')}</Label>
              <Textarea rows={8} value={text(runtime.destructivePatterns)} onChange={(e) => updateRuntime((current) => ({ ...current, destructivePatterns: list(e.target.value) }))} />
            </TabsContent>

            <TabsContent value="secretPatterns" className="space-y-1">
              <Label>{t('allowlistRegex.labels.secretPatterns')}</Label>
              <Textarea rows={8} value={text(runtime.secretPatterns)} onChange={(e) => updateRuntime((current) => ({ ...current, secretPatterns: list(e.target.value) }))} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      )}

      {activeSection === 'policyGuards' && (
      <Card>
        <CardHeader>
          <CardTitle>{t('policyGuards.title')}</CardTitle>
          <CardDescription>{t('policyGuards.description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label>{t('policyGuards.labels.allowPathPrefixes')}</Label>
            <Textarea
              rows={6}
              value={text(runtime.allowPathPrefixes)}
              onChange={(e) => updateRuntime((current) => ({ ...current, allowPathPrefixes: list(e.target.value) }))}
            />
          </div>
          <div className="space-y-1">
            <Label>{t('policyGuards.labels.allowDomains')}</Label>
            <Textarea
              rows={6}
              value={text(runtime.allowDomains)}
              onChange={(e) => updateRuntime((current) => ({ ...current, allowDomains: list(e.target.value) }))}
            />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>{t('policyGuards.labels.auditEgressAllowlist')}</Label>
            <Textarea
              rows={4}
              value={text(runtime.auditEgressAllowlist)}
              onChange={(e) => updateRuntime((current) => ({ ...current, auditEgressAllowlist: list(e.target.value) }))}
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
              rows={6}
              value={text(runtime.promptInjectionPatterns)}
              onChange={(e) => updateRuntime((current) => ({ ...current, promptInjectionPatterns: list(e.target.value) }))}
            />
          </div>
        </CardContent>
      </Card>
      )}

      {activeSection === 'actionCenter' && (
      <Card>
        <CardHeader>
          <CardTitle>{t('actionCenter.title')}</CardTitle>
          <CardDescription>{t('actionCenter.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              title={t('actionCenter.quickAuditTitle')}
              variant="outline"
              disabled={securityOpBusy !== null}
              onClick={() => void runSecurityOp(t('actionCenter.quickAudit'), async () => await hostSecurityRunQuickAudit())}
            >
              {t('actionCenter.quickAudit')}
            </Button>
            <Button
              title={t('actionCenter.emergencyTitle')}
              variant="destructive"
              disabled={securityOpBusy !== null}
              onClick={() => void runSecurityOp(t('actionCenter.emergency'), async () => await hostSecurityRunEmergencyResponse())}
            >
              {t('actionCenter.emergency')}
            </Button>
            <Button variant="outline" disabled={securityOpBusy !== null} onClick={() => void runSecurityOp(t('actionCenter.integrity'), async () => await hostSecurityCheckIntegrity())}>{t('actionCenter.integrity')}</Button>
            <Button variant="outline" disabled={securityOpBusy !== null} onClick={() => void runSecurityOp(t('actionCenter.rebaseline'), async () => await hostSecurityRebaselineIntegrity())}>{t('actionCenter.rebaseline')}</Button>
            <Button variant="outline" disabled={securityOpBusy !== null} onClick={() => void runSecurityOp(t('actionCenter.skillScan'), async () => await hostSecurityScanSkills())}>{t('actionCenter.skillScan')}</Button>
            <Button variant="outline" disabled={securityOpBusy !== null} onClick={() => void runSecurityOp(t('actionCenter.advisories'), async () => await hostSecurityCheckAdvisories())}>{t('actionCenter.advisories')}</Button>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={securityOpBusy !== null} onClick={() => void runSecurityOp(t('actionCenter.remediationPreview'), async () => {
              const payload = await hostSecurityPreviewRemediation<{ actions?: RemediationActionItem[] }>();
              const actions = Array.isArray(payload.actions) ? payload.actions : [];
              setRemediationActions(actions);
              return payload;
            })}>{t('actionCenter.remediationPreview')}</Button>
            <Button disabled={securityOpBusy !== null || selectedRemediationActions.length === 0} onClick={() => void runSecurityOp(t('actionCenter.remediationApply'), async () => {
              const payload = await hostSecurityApplyRemediation<{ snapshotId?: string }>(selectedRemediationActions);
              if (payload.snapshotId) setLastRemediationSnapshotId(payload.snapshotId);
              return payload;
            })}>{t('actionCenter.remediationApply')}</Button>
            <Button variant="outline" disabled={securityOpBusy !== null} onClick={() => void runSecurityOp(t('actionCenter.remediationRollback'), async () => await hostSecurityRollbackRemediation(lastRemediationSnapshotId))}>{t('actionCenter.remediationRollback')}</Button>
          </div>

          {remediationActions.length > 0 && (
            <div className="space-y-2 rounded-md border p-3">
              {remediationActions.map((item) => (
                <label key={item.id} className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={selectedRemediationActions.includes(item.id)} onChange={(e) => setSelectedRemediationActions((prev) => (e.target.checked ? [...prev, item.id] : prev.filter((id) => id !== item.id)))} />
                  <span><span className="font-medium">{item.title}</span><span className="ml-2 text-xs text-muted-foreground">[{item.risk}]</span><p className="text-xs text-muted-foreground">{item.description}</p></span>
                </label>
              ))}
            </div>
          )}

          {securityOpResult && <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-2 text-xs">{securityOpResult}</pre>}
        </CardContent>
      </Card>
      )}

      {activeSection === 'auditHits' && (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div><CardTitle>{t('audit.title')}</CardTitle><CardDescription>{t('audit.description')}</CardDescription></div>
          <Button variant="outline" size="sm" onClick={() => void loadRecentAudits({ gatewayState, page: 1, pageSize: 8 })}>{t('audit.refresh')}</Button>
        </CardHeader>
        <CardContent>
          {gatewayState !== 'running' ? <p className="text-sm text-muted-foreground">{t('audit.gatewayStopped')}</p> : loadingAudit ? <p className="text-sm text-muted-foreground">{t('audit.loading')}</p> : auditItems.length === 0 ? <p className="text-sm text-muted-foreground">{t('audit.empty')}</p> : (
            <div className="space-y-2">
              {auditItems.map((item, index) => (
                <div key={`${item.ts}-${index}`} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-medium">{item.toolName || '-'}</div>
                    <div className="flex items-center gap-2"><Badge variant="outline">{localizeAuditRisk(item.risk)}</Badge><Badge variant="outline">{localizeAuditAction(item.action)}</Badge></div>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{new Date(item.ts).toLocaleString()} · {t('audit.ruleLabel')}: {item.ruleId || '-'} · {t('audit.decisionLabel')}: {item.decision || '-'}</div>
                  {item.detail && <p className="mt-1 text-xs text-muted-foreground">{localizeAuditDetail(item)}</p>}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      )}
        </div>
      </div>
    </section>
  );
}

export default SecurityPage;
