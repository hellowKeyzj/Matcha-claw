import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useSecurityPolicyStore } from './security-policy-store';
import { useSecuritySupportStore, type AllowlistRegexTab, type PlatformTool } from './security-support-store';
import type { SecuritySectionProps } from './extensions';
import { parsePolicyList } from './policy-fields';

export function AllowlistRegexSection({ policyControlsDisabled }: SecuritySectionProps) {
  const { t, i18n } = useTranslation('security');
  const runtime = useSecurityPolicyStore((state) => state.policy.runtime);
  const updateRuntime = useSecurityPolicyStore((state) => state.updateRuntime);
  const allowlistRegexTab = useSecuritySupportStore((state) => state.allowlistRegexTab);
  const setAllowlistRegexTab = useSecuritySupportStore((state) => state.setAllowlistRegexTab);
  const platformTools = useSecuritySupportStore((state) => state.platformTools);
  const loadingPlatformTools = useSecuritySupportStore((state) => state.loadingPlatformTools);
  const platformToolsError = useSecuritySupportStore((state) => state.platformToolsError);
  const loadPlatformTools = useSecuritySupportStore((state) => state.loadPlatformTools);
  const selectedToolCount = runtime.allowlist.tools.length;
  const selectedToolSet = new Set(runtime.allowlist.tools);
  const enabledPlatformToolIds = platformTools
    .filter((tool) => tool.enabled !== false)
    .map((tool) => tool.id);

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
  return (
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
                  disabled={policyControlsDisabled || enabledPlatformToolIds.length === 0}
                  onClick={() => updateAllowlistTools(enabledPlatformToolIds)}
                >
                  {t('allowlistRegex.writeEnabledTools')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={policyControlsDisabled || selectedToolCount === 0}
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
                          disabled={policyControlsDisabled}
                          onClick={() => toggleAllowlistTool(tool.id)}
                          className={`h-full min-w-0 rounded-md border px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
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
              <Textarea disabled={policyControlsDisabled} rows={8} value={runtime.allowlist.sessions.join(', ')} onChange={(e) => updateRuntime((current) => ({ ...current, allowlist: { ...current.allowlist, sessions: parsePolicyList(e.target.value) } }))} />
            </TabsContent>

            <TabsContent value="destructivePatterns" className="space-y-1">
              <Label>{t('allowlistRegex.labels.destructivePatterns')}</Label>
              <Textarea disabled={policyControlsDisabled} rows={8} value={runtime.destructivePatterns.join(', ')} onChange={(e) => updateRuntime((current) => ({ ...current, destructivePatterns: parsePolicyList(e.target.value) }))} />
            </TabsContent>

            <TabsContent value="secretPatterns" className="space-y-1">
              <Label>{t('allowlistRegex.labels.secretPatterns')}</Label>
              <Textarea disabled={policyControlsDisabled} rows={8} value={runtime.secretPatterns.join(', ')} onChange={(e) => updateRuntime((current) => ({ ...current, secretPatterns: parsePolicyList(e.target.value) }))} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
  );
}
