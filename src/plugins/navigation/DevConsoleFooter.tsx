import { Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { hostApiFetch } from '@/lib/host-api';
import { useSettingsStore } from '@/plugins/settings/store';
import { useLocalLicenseLocked } from '@/plugins/account/stores/license';

export default function DevConsoleFooter() {
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);
  const licenseLocked = useLocalLicenseLocked();
  const { t } = useTranslation();

  const openDevConsole = async () => {
    try {
      const result = await hostApiFetch<{
        success: boolean;
        url?: string;
        error?: string;
      }>('/api/gateway/control-ui');
      if (result.success && result.url) {
        window.electron.openExternal(result.url);
      } else {
        console.error('Failed to get Dev Console URL:', result.error);
      }
    } catch (error) {
      console.error('Error opening Dev Console:', error);
    }
  };

  if (!devModeUnlocked) return null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="mx-auto flex h-9 w-9 shrink-0 rounded-[12px]"
      title={t('sidebar.devConsole')}
      aria-label={t('sidebar.devConsole')}
      onClick={openDevConsole}
      disabled={licenseLocked}
    >
      <Terminal aria-hidden="true" className="h-[18px] w-[18px]" />
    </Button>
  );
}
