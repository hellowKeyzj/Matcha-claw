import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useSecuritySupportStore, type RuleCatalogPlatform } from './security-support-store';

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

function normalizeRuleReasonText(reason: string): string {
  return reason
    .trim()
    .replaceAll('（', '(')
    .replaceAll('）', ')')
    .replace(/\s+/g, ' ');
}

export function RuleCatalogSection() {
  const { t } = useTranslation('security');
  const ruleCatalog = useSecuritySupportStore((state) => state.ruleCatalog);
  const ruleCatalogPlatform = useSecuritySupportStore((state) => state.ruleCatalogPlatform);
  const setRuleCatalogPlatform = useSecuritySupportStore((state) => state.setRuleCatalogPlatform);
  const loadingRuleCatalog = useSecuritySupportStore((state) => state.loadingRuleCatalog);
  const ruleCatalogError = useSecuritySupportStore((state) => state.ruleCatalogError);
  const loadRuleCatalog = useSecuritySupportStore((state) => state.loadRuleCatalog);
  const displayedRuleCatalog = ruleCatalog
    .filter((item) => ruleCatalogPlatform === 'all' ? true : item.platform === ruleCatalogPlatform || item.platform === 'universal')
    .sort((a, b) => {
      if (a.platform === b.platform) return a.command.localeCompare(b.command);
      return a.platform.localeCompare(b.platform);
    });

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
  return (
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
  );
}
