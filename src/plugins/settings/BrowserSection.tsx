import { useCallback, useEffect, useState } from 'react';
import { Copy, ExternalLink, FolderOpen, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { SettingsSectionProps } from '@/app/extensions';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc, toUserMessage } from '@/lib/api-client';
import { useLocalLicenseLocked } from '@/plugins/account/stores/license';
import { useSettingsStore } from './store';

type BrowserRelayInfo = {
  relativeDir: string;
  extensionDir: string;
  exists: boolean;
  chromeExtensionsUrl: string;
};

type BrowserMode = 'iab' | 'native' | 'relay' | 'off';

export default function BrowserSection({ active }: SettingsSectionProps) {
  const { t } = useTranslation(['settings', 'common']);
  const licenseLocked = useLocalLicenseLocked();
  const browserMode = useSettingsStore((state) => state.browserMode);
  const saveRuntimeSettings = useSettingsStore((state) => state.saveRuntimeSettings);
  const [savingBrowserMode, setSavingBrowserMode] = useState(false);
  const [browserRelayInfo, setBrowserRelayInfo] = useState<BrowserRelayInfo | null>(null);

  const handleCopyBrowserRelayPath = useCallback(async () => {
    const target = browserRelayInfo?.extensionDir ?? browserRelayInfo?.relativeDir;
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target);
      toast.success(t('common:actions.copy'));
    } catch (error) {
      toast.error(`${t('common:status.error')}: ${String(error)}`);
    }
  }, [browserRelayInfo, t]);

  const handleCopyChromeExtensionsUrl = useCallback(async () => {
    const target = browserRelayInfo?.chromeExtensionsUrl ?? 'chrome://extensions/';
    try {
      await navigator.clipboard.writeText(target);
      toast.success(t('common:actions.copy'));
    } catch (error) {
      toast.error(`${t('common:status.error')}: ${String(error)}`);
    }
  }, [browserRelayInfo?.chromeExtensionsUrl, t]);

  const handleOpenChromeExtensionsUrl = useCallback(async () => {
    try {
      await invokeIpc('shell:openChromeExtensions');
    } catch (error) {
      toast.error(`${t('common:status.error')}: ${String(error)}`);
    }
  }, [t]);

  const handleRevealBrowserRelayDir = useCallback(async () => {
    const target = browserRelayInfo?.extensionDir;
    if (!target) return;
    try {
      await invokeIpc('shell:showItemInFolder', target);
    } catch (error) {
      toast.error(`${t('common:status.error')}: ${String(error)}`);
    }
  }, [browserRelayInfo?.extensionDir, t]);

  useEffect(() => {
    if (licenseLocked) return;
    let cancelled = false;

    (async () => {
      try {
        const result = await hostApiFetch<BrowserRelayInfo>('/api/app/browser-relay-info');
        if (!cancelled) {
          setBrowserRelayInfo(result);
        }
      } catch {
        if (!cancelled) {
          setBrowserRelayInfo(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [licenseLocked]);

  const handleSaveBrowserMode = useCallback(async (nextMode: BrowserMode) => {
    if (savingBrowserMode || nextMode === browserMode) {
      return;
    }
    setSavingBrowserMode(true);
    try {
      await saveRuntimeSettings({ browserMode: nextMode });
      toast.success(t('gateway.browser.modeSaved'));
    } catch (error) {
      toast.error(`${t('gateway.browser.modeSaveFailed')}: ${toUserMessage(error)}`);
    } finally {
      setSavingBrowserMode(false);
    }
  }, [browserMode, saveRuntimeSettings, savingBrowserMode, t]);

  if (!active) return null;
  return (
            <Card className="order-1">
              <CardHeader>
                <CardTitle>{t('gateway.browser.title')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3 rounded-xl border border-border/60 p-5">
                  <div className="space-y-1">
                    <Label>{t('gateway.browser.modeLabel')}</Label>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {([
                      {
                        value: 'iab',
                        label: t('gateway.browser.modes.iab.title'),
                        description: t('gateway.browser.modes.iab.description'),
                      },
                      {
                        value: 'native',
                        label: t('gateway.browser.modes.native.title'),
                        description: t('gateway.browser.modes.native.description'),
                      },
                      {
                        value: 'relay',
                        label: t('gateway.browser.modes.relay.title'),
                        description: t('gateway.browser.modes.relay.description'),
                      },
                      {
                        value: 'off',
                        label: t('gateway.browser.modes.off.title'),
                        description: t('gateway.browser.modes.off.description'),
                      },
                    ] as const).map((option) => {
                      const active = browserMode === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => void handleSaveBrowserMode(option.value)}
                          disabled={savingBrowserMode}
                          className={`rounded-xl border p-4 text-left transition-colors ${
                            active
                              ? 'border-primary bg-primary/8'
                              : 'border-border/60 bg-background/40 hover:border-border'
                          } ${savingBrowserMode ? 'cursor-wait opacity-70' : ''}`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="font-medium">{option.label}</div>
                            {active ? <Badge className="shrink-0" variant="secondary">{t('gateway.browser.currentMode')}</Badge> : null}
                          </div>
                          <p className="mt-2 text-sm text-muted-foreground">{option.description}</p>
                        </button>
                      );
                    })}
                  </div>
                  {savingBrowserMode ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>{t('gateway.browser.modeSaving')}</span>
                    </div>
                  ) : null}
                </div>

                {browserMode === 'relay' && (
                <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" onClick={handleOpenChromeExtensionsUrl}>
                      <ExternalLink className="mr-2 h-4 w-4" />
                      {t('gateway.browser.openChromeExtensions')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleRevealBrowserRelayDir}
                      disabled={!browserRelayInfo?.exists}
                    >
                      <FolderOpen className="mr-2 h-4 w-4" />
                      {t('gateway.browser.revealExtensionDir')}
                    </Button>
                    <Button type="button" variant="outline" onClick={handleCopyBrowserRelayPath}>
                      <Copy className="mr-2 h-4 w-4" />
                      {t('gateway.browser.copyExtensionPath')}
                    </Button>
                    <Button type="button" variant="outline" onClick={handleCopyChromeExtensionsUrl}>
                      <Copy className="mr-2 h-4 w-4" />
                      {t('gateway.browser.copyChromeExtensions')}
                    </Button>
                  </div>
                </div>
                )}

                {browserMode === 'relay' && (
                <div className="space-y-3 rounded-xl border border-border/60 p-5">
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-semibold">1</div>
                    <div className="space-y-2">
                      <p className="text-lg font-semibold">{t('gateway.browser.steps.enableDevModeTitle')}</p>
                      <p className="text-sm text-muted-foreground">{t('gateway.browser.steps.enableDevModeBody')}</p>
                      <div className="rounded-lg border border-border bg-background/60 px-3 py-2 font-mono text-sm">
                        {browserRelayInfo?.chromeExtensionsUrl ?? 'chrome://extensions/'}
                      </div>
                    </div>
                  </div>
                </div>
                )}

                {browserMode === 'relay' && (
                <div className="space-y-3 rounded-xl border border-border/60 p-5">
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-semibold">2</div>
                    <div className="space-y-2">
                      <p className="text-lg font-semibold">{t('gateway.browser.steps.openFolderTitle')}</p>
                      <p className="text-sm text-muted-foreground">{t('gateway.browser.steps.openFolderBody')}</p>
                      <div className="rounded-lg border border-border bg-background/60 px-3 py-2 font-mono text-sm break-all">
                        {browserRelayInfo?.relativeDir ?? 'resources/tools/data/extension/chrome-extension/browser-relay'}
                      </div>
                      {browserRelayInfo?.extensionDir ? (
                        <p className="text-xs text-muted-foreground break-all">
                          {t('gateway.browser.absolutePathLabel')}: {browserRelayInfo.extensionDir}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
                )}

                {browserMode === 'relay' && (
                <div className="space-y-3 rounded-xl border border-border/60 p-5">
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-semibold">3</div>
                    <div className="space-y-2">
                      <p className="text-lg font-semibold">{t('gateway.browser.steps.installTitle')}</p>
                      <p className="text-sm text-muted-foreground">{t('gateway.browser.steps.installBody')}</p>
                      <p className="text-xs text-muted-foreground">{t('gateway.browser.steps.installHint')}</p>
                    </div>
                  </div>
                </div>
                )}

                {browserMode === 'iab' && (
                <div className="rounded-xl border border-border/60 p-5">
                  <p className="text-lg font-semibold">{t('gateway.browser.iabModeTitle')}</p>
                  <p className="mt-2 text-sm text-muted-foreground">{t('gateway.browser.iabModeBody')}</p>
                </div>
                )}

                {browserMode === 'native' && (
                <div className="rounded-xl border border-border/60 p-5">
                  <p className="text-lg font-semibold">{t('gateway.browser.nativeModeTitle')}</p>
                  <p className="mt-2 text-sm text-muted-foreground">{t('gateway.browser.nativeModeBody')}</p>
                </div>
                )}

                {browserMode === 'off' && (
                <div className="rounded-xl border border-border/60 p-5">
                  <p className="text-lg font-semibold">{t('gateway.browser.offModeTitle')}</p>
                  <p className="mt-2 text-sm text-muted-foreground">{t('gateway.browser.offModeBody')}</p>
                </div>
                )}
              </CardContent>
            </Card>
  );
}
