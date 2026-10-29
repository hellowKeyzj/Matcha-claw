import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useWorldStore } from '../store';
import { Empty } from './components';
import { Operations } from './Operations';
import { Packages } from './Packages';
import { StorageConfiguration } from './StorageSettings';

export function Settings({ projectionBlocked }: { projectionBlocked: boolean }) {
  const { t } = useTranslation('world');
  const [searchParams, setSearchParams] = useSearchParams();
  const world = useWorldStore(state => state.world);
  const status = useWorldStore(state => state.description?.status);
  const requested = searchParams.get('tab');
  const tab = requested === 'capabilities' || requested === 'operations' ? requested : 'storage';
  return (
    <Tabs className="world-data-tabs" value={tab} onValueChange={value => setSearchParams(value === 'storage' ? {} : { tab: value })}>
      <TabsList variant="line" aria-label={t('pages.settings')}>
        <TabsTrigger value="storage">{t('settings.storage')}</TabsTrigger>
        <TabsTrigger value="capabilities">{t('settings.capabilities')}</TabsTrigger>
        <TabsTrigger value="operations">{t('settings.operations')}</TabsTrigger>
      </TabsList>
      <TabsContent className="world-content-page" value="storage"><StorageConfiguration /></TabsContent>
      <TabsContent className="world-content-page" value="capabilities">
        <fieldset className="min-w-0" disabled={projectionBlocked}>
          {world && status === 'ready' ? <Packages /> : <Empty>{t('settings.openForCapabilities')}</Empty>}
        </fieldset>
      </TabsContent>
      <TabsContent className="world-content-page" value="operations">
        {world ? <Operations /> : <Empty>{t('settings.openForOperations')}</Empty>}
      </TabsContent>
    </Tabs>
  );
}
