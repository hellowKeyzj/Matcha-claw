import { useCallback, useState } from 'react';
import { Download, FileText, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { SettingsSectionProps } from '@/app/extensions';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { collectDiagnosticsArchive, exportDiagnosticsArchive } from './services/diagnostics-archive';

export default function DiagnosticsSection({ active }: SettingsSectionProps) {
  const { t } = useTranslation('settings');
  const [collectingDiagnostics, setCollectingDiagnostics] = useState(false);
  const [lastDiagnosticsArchiveId, setLastDiagnosticsArchiveId] = useState('');
  const [lastDiagnosticsEntries, setLastDiagnosticsEntries] = useState(0);
  const [lastDiagnosticsBytes, setLastDiagnosticsBytes] = useState(0);

  const handleCollectDiagnosticsBundle = useCallback(async () => {
    setCollectingDiagnostics(true);
    try {
      const receipt = await collectDiagnosticsArchive();
      const exportResult = await exportDiagnosticsArchive(receipt.archiveId);
      if (exportResult.status === 'cancelled') {
        toast.info(t('diagnostics.toast.cancelled'));
        return;
      }
      if (exportResult.status === 'failed') {
        toast.error(t('diagnostics.toast.exportFailed'));
        return;
      }
      setLastDiagnosticsArchiveId(receipt.archiveId);
      setLastDiagnosticsEntries(receipt.entries);
      setLastDiagnosticsBytes(receipt.bytes);
      toast.success(t('diagnostics.toast.success', { count: receipt.entries }));
    } catch (error) {
      toast.error(t('diagnostics.toast.failed', { error: String(error) }));
    } finally {
      setCollectingDiagnostics(false);
    }
  }, [t]);

  if (!active) return null;
  return (
      <Card className="order-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {t('diagnostics.title')}
          </CardTitle>
          <CardDescription>{t('diagnostics.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => {
                void handleCollectDiagnosticsBundle();
              }}
              disabled={collectingDiagnostics}
            >
              {collectingDiagnostics ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              {collectingDiagnostics ? t('diagnostics.collecting') : t('diagnostics.collect')}
            </Button>
          </div>

          {lastDiagnosticsArchiveId ? (
            <div className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-3">
              <Label>{t('diagnostics.lastBundle')}</Label>
              <Input readOnly value={lastDiagnosticsArchiveId} className="font-mono" />
              <p className="text-xs text-muted-foreground">
                {t('diagnostics.lastMeta', {
                  count: lastDiagnosticsEntries,
                  bytes: lastDiagnosticsBytes,
                })}
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>
  );
}
