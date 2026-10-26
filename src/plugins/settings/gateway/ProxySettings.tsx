import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { toUserMessage } from '@/lib/api-client';
import { trackUiEvent } from '@/lib/telemetry';
import { useSettingsStore } from '../store';
import type { SettingsSectionProps } from '@/app/extensions';

export function ProxySettings({ active }: SettingsSectionProps) {
  const { t } = useTranslation(['settings', 'common']);
  const saveRuntimeSettings = useSettingsStore((state) => state.saveRuntimeSettings);
  const proxyEnabled = useSettingsStore((state) => state.proxyEnabled);
  const proxyServer = useSettingsStore((state) => state.proxyServer);
  const proxyBypassRules = useSettingsStore((state) => state.proxyBypassRules);
  const [proxyDraft, setProxyDraft] = useState({ proxyEnabled, proxyServer, proxyBypassRules });
  const {
    proxyEnabled: proxyEnabledDraft,
    proxyServer: proxyServerDraft,
    proxyBypassRules: proxyBypassRulesDraft,
  } = proxyDraft;
  const proxySyncedDraftRef = useRef(proxyDraft);
  const [proxySettingsExpanded, setProxySettingsExpanded] = useState(false);
  const [savingProxy, setSavingProxy] = useState(false);

  useEffect(() => {
    const previous = proxySyncedDraftRef.current;
    const next = { proxyEnabled, proxyServer, proxyBypassRules };
    proxySyncedDraftRef.current = next;
    if (savingProxy || (
      previous.proxyEnabled === proxyEnabled
      && previous.proxyServer === proxyServer
      && previous.proxyBypassRules === proxyBypassRules
    )) return;
    setProxyDraft((current) => (
      current.proxyEnabled === previous.proxyEnabled
      && current.proxyServer.trim() === previous.proxyServer
      && current.proxyBypassRules.trim() === previous.proxyBypassRules
    ) ? next : current);
  }, [proxyEnabled, proxyServer, proxyBypassRules, savingProxy]);

  const proxySettingsDirty = useMemo(() => (
    proxyEnabledDraft !== proxyEnabled
    || proxyServerDraft.trim() !== proxyServer
    || proxyBypassRulesDraft.trim() !== proxyBypassRules
  ), [
    proxyBypassRules,
    proxyBypassRulesDraft,
    proxyEnabled,
    proxyEnabledDraft,
    proxyServer,
    proxyServerDraft,
  ]);

  const handleSaveProxySettings = async () => {
    const submittedDraft = proxyDraft;
    const savedProxy = {
      proxyEnabled: submittedDraft.proxyEnabled,
      proxyServer: submittedDraft.proxyServer.trim(),
      proxyBypassRules: submittedDraft.proxyBypassRules.trim(),
    };
    setSavingProxy(true);
    try {
      await saveRuntimeSettings(savedProxy);
      proxySyncedDraftRef.current = savedProxy;
      setProxyDraft((current) => (
        current.proxyEnabled === submittedDraft.proxyEnabled
        && current.proxyServer === submittedDraft.proxyServer
        && current.proxyBypassRules === submittedDraft.proxyBypassRules
      ) ? savedProxy : current);

      toast.success(t('gateway.proxySaved'));
      trackUiEvent('settings.proxy_saved', { enabled: proxyEnabledDraft });
    } catch (error) {
      toast.error(`${t('gateway.proxySaveFailed')}: ${toUserMessage(error)}`);
    } finally {
      setSavingProxy(false);
    }
  };

  if (!active) return null;
  return (
          <div className="rounded-md border border-border/60 p-3">
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-start p-0 hover:bg-transparent"
              onClick={() => setProxySettingsExpanded((prev) => !prev)}
              data-testid="settings-proxy-expand"
            >
              <div className="flex items-center gap-2">
                {proxySettingsExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
                <div className="text-left">
                  <Label>{t('gateway.proxyTitle')}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t('gateway.proxyDesc')}
                  </p>
                </div>
              </div>
            </Button>

            {proxySettingsExpanded && (
              <div className="mt-4 space-y-4" data-testid="settings-proxy-section">
                <div className="flex items-center justify-between">
                  <Label>{t('gateway.proxyTitle')}</Label>
                  <Switch
                    checked={proxyEnabledDraft}
                    onCheckedChange={(proxyEnabled) => setProxyDraft((current) => ({ ...current, proxyEnabled }))}
                    data-testid="settings-proxy-toggle"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="proxy-server">{t('gateway.proxyServer')}</Label>
                  <Input
                    id="proxy-server"
                    value={proxyServerDraft}
                    onChange={({ target: { value } }) => setProxyDraft((current) => ({ ...current, proxyServer: value }))}
                    placeholder="http://127.0.0.1:7890"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('gateway.proxyServerHelp')}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="proxy-bypass">{t('gateway.proxyBypass')}</Label>
                  <Input
                    id="proxy-bypass"
                    value={proxyBypassRulesDraft}
                    onChange={({ target: { value } }) => setProxyDraft((current) => ({ ...current, proxyBypassRules: value }))}
                    placeholder="<local>;localhost;127.0.0.1;::1"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('gateway.proxyBypassHelp')}
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/40 p-3">
                  <p className="text-sm text-muted-foreground">
                    {t('gateway.proxyRestartNote')}
                  </p>
                  <Button
                    variant="outline"
                    onClick={handleSaveProxySettings}
                    disabled={savingProxy || !proxySettingsDirty}
                    data-testid="settings-proxy-save-button"
                  >
                    <RefreshCw className={`h-4 w-4 mr-2${savingProxy ? ' animate-spin' : ''}`} />
                    {savingProxy ? t('common:status.saving') : t('common:actions.save')}
                  </Button>
                </div>
              </div>
            )}
          </div>
  );
}
