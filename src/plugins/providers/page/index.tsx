import { useTranslation } from 'react-i18next';
import { ProvidersSettings } from '@/plugins/providers/components/ProvidersSettings';
import { MediaCapabilitiesPanel } from '@/plugins/providers/components/MediaCapabilitiesPanel';

export function ProvidersPage() {
  const { t } = useTranslation('settings');

  return (
    <section className="mx-auto w-full max-w-6xl space-y-6 text-foreground">
      <header>
        <h1 className="text-2xl font-semibold tracking-[-0.035em] text-foreground">{t('aiProviders.title')}</h1>
        <p className="mt-1 max-w-2xl text-sm text-[hsl(var(--shell-text-muted))]">{t('aiProviders.description')}</p>
      </header>
      <MediaCapabilitiesPanel />
      <ProvidersSettings />
    </section>
  );
}
