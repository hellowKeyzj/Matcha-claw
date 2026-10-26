import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { useSettingsStore } from '../store';
import { UpdateSettings } from './UpdateSettings';

export default function UpdatesSection() {
  const { t } = useTranslation('settings');
  const autoCheckUpdate = useSettingsStore((state) => state.autoCheckUpdate);
  const setAutoCheckUpdate = useSettingsStore((state) => state.setAutoCheckUpdate);

  return (
      <Card className="order-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            {t('updates.title')}
          </CardTitle>
          <CardDescription>{t('updates.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <UpdateSettings />

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label>{t('updates.autoCheck')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('updates.autoCheckDesc')}
              </p>
            </div>
            <Switch
              checked={autoCheckUpdate}
              onCheckedChange={(value) => { void setAutoCheckUpdate(value).catch(() => {}); }}
            />
          </div>

        </CardContent>
      </Card>
  );
}
