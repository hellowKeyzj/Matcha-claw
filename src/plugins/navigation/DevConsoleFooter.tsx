import { ExternalLink, Terminal } from 'lucide-react';
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
      variant="ghost"
      size="sm"
      className="w-full justify-start"
      onClick={openDevConsole}
      disabled={licenseLocked}
    >
      <Terminal className="mr-2 h-4 w-4" />
      {t('sidebar.devConsole')}
      <ExternalLink className="ml-auto h-3 w-3" />
    </Button>
  );
}
