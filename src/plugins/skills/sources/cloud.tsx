import { useEffect, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Download, Package, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { AgentPageToolbar, AgentResourceCard, AgentResourceFooter, AgentResourceGrid, AgentResourceIcon } from '@/components/common/AgentPage';
import { LoadingState } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { sealedSkillErrorMessage } from '@/lib/sealed-skills-error';
import { useAccountStore } from '@/plugins/account/stores/account';
import type { SealedSkillCloudPackage } from '@/types/skill';
import type { SkillToolbarProps, SkillViewProps } from '../extensions';
import {
  PACKAGE_CARD_FOOTER_CLASS_NAME,
  SKILL_CARD_DESCRIPTION_CLASS_NAME,
  SKILL_CARD_ICON_CLASS_NAME,
  isPackageDigest,
  SkillFolderButton,
  SkillRefreshButton,
} from '../presentation';
import { getSealedSkillCloudPackageKey, useSealedSkillsStore } from '../stores/sealed-skills';

type CloudPanel = 'mine' | 'market';

function CloudPackagePanel({ panel, view, query, children }: {
  panel: CloudPanel;
  view: SkillViewProps['view'];
  query: string;
  children: ReactNode[];
}) {
  const { t } = useTranslation('skills');
  const loading = useSealedSkillsStore((state) => panel === 'mine' ? state.myCloudLoading : state.cloudLoading);
  const loaded = useSealedSkillsStore((state) => panel === 'mine' ? state.myCloudLoaded : state.cloudLoaded);
  const error = useSealedSkillsStore((state) => panel === 'mine' ? state.myCloudError : state.cloudError);
  const refresh = useSealedSkillsStore((state) => panel === 'mine' ? state.fetchMyCloudSkillPackages : state.fetchCloudSkillPackages);
  const userId = useAccountStore((state) => state.user?.id);
  const signedOut = useAccountStore((state) => state.status === 'signedOut' || state.status === 'requires2fa');

  useEffect(() => {
    void refresh();
  }, [refresh, userId, signedOut]);

  return (
    <div className="space-y-4">
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
          <AlertCircle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words text-destructive">{sealedSkillErrorMessage(error, t, 'sealed.errors.listFailed')}</span>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => { void refresh(); }}>{t('sealed.retry')}</Button>
        </div>
      )}
      {!loaded ? (
        <LoadingState label={t('sealed.cloudLoading')} />
      ) : children.length === 0 ? (
        !error && <p className="py-8 text-sm text-muted-foreground">{query ? t('noSkillsSearch') : t(panel === 'mine' ? 'sealed.mineEmpty' : 'sealed.cloudEmpty')}</p>
      ) : (
        <AgentResourceGrid className={view === 'list' ? 'md:grid-cols-1 xl:grid-cols-1' : undefined}>
          {children}
        </AgentResourceGrid>
      )}
    </div>
  );
}

function CloudToolbar({ panel, active, navigation, entries, viewControls }: SkillToolbarProps & { panel: CloudPanel }) {
  const { t } = useTranslation('skills');
  const [searchParams, setSearchParams] = useSearchParams();
  const searchLabel = t(panel === 'mine' ? 'sealed.searchMine' : 'sealed.searchMarket');
  if (!active) return null;

  return (
    <AgentPageToolbar className="w-full max-w-full flex-nowrap overflow-x-auto">
      {navigation}
      <div className="relative min-w-40 max-w-72 flex-1">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={searchParams.get('packageSearch') || ''}
          onChange={(event) => {
            const value = event.target.value;
            setSearchParams((params) => {
              const next = new URLSearchParams(params);
              if (value) next.set('packageSearch', value);
              else next.delete('packageSearch');
              return next;
            }, { replace: true });
          }}
          className="h-9 pl-9 text-sm"
        />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {entries}
        {viewControls}
      </div>
    </AgentPageToolbar>
  );
}

export function CloudMineToolbar(props: SkillToolbarProps) {
  return <CloudToolbar {...props} panel="mine" />;
}

export function CloudMarketToolbar(props: SkillToolbarProps) {
  return <CloudToolbar {...props} panel="market" />;
}

function CloudHeaderActions({ panel, ...props }: SkillViewProps & { panel: CloudPanel }) {
  const loading = useSealedSkillsStore((state) => panel === 'mine' ? state.myCloudLoading : state.cloudLoading);
  const refresh = useSealedSkillsStore((state) => panel === 'mine' ? state.fetchMyCloudSkillPackages : state.fetchCloudSkillPackages);
  if (!props.active) return null;

  return (
    <>
      <SkillRefreshButton refreshing={loading} disabled={loading} onClick={() => { void refresh(); }} />
      <SkillFolderButton {...props} />
    </>
  );
}

export function CloudMineHeaderActions(props: SkillViewProps) {
  return <CloudHeaderActions {...props} panel="mine" />;
}

export function CloudMarketHeaderActions(props: SkillViewProps) {
  return <CloudHeaderActions {...props} panel="market" />;
}

export function CloudMineView({ active, view }: SkillViewProps) {
  const { t } = useTranslation('skills');
  const [searchParams] = useSearchParams();
  const packages = useSealedSkillsStore((state) => state.myCloudPackages);
  const publishingByVersionId = useSealedSkillsStore((state) => state.cloudPublishingByVersionId);
  const publish = useSealedSkillsStore((state) => state.publishCloudSkillPackage);
  if (!active) return null;
  const query = (searchParams.get('packageSearch') || '').trim().toLowerCase();
  const filteredPackages = packages.filter((item) => [item.displayName, item.name, item.description, item.packageId, item.packageVersionId].some((value) => value?.toLowerCase().includes(query)));

  const handlePublish = async (packageVersionId: string) => {
    try {
      const result = await publish(packageVersionId);
      if (!result) return;
      if (!result.refreshed) toast.warning(t('sealed.publishedRefreshFailed'));
      else toast.success(t('sealed.published'));
    } catch (error) {
      toast.error(sealedSkillErrorMessage(error, t, 'sealed.publishFailed'));
    }
  };

  return (
    <CloudPackagePanel panel="mine" view={view} query={query}>
      {filteredPackages.map((item) => {
        const displayName = item.displayName || item.name;
        const publishing = Boolean(publishingByVersionId[item.packageVersionId]);
        return (
          <AgentResourceCard key={item.packageVersionId} className="gap-3 p-4">
            <div className="flex min-w-0 items-center gap-3">
              <AgentResourceIcon className={SKILL_CARD_ICON_CLASS_NAME}><Package className="size-5" aria-hidden="true" /></AgentResourceIcon>
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold">{displayName}</h3>
                {item.name !== displayName && <p className="mt-1 truncate text-xs text-muted-foreground">{item.name}</p>}
              </div>
            </div>
            <p className={SKILL_CARD_DESCRIPTION_CLASS_NAME}>{item.description || t('sealed.noDescription')}</p>
            {item.version && !isPackageDigest(item.version) && <p className="text-xs text-muted-foreground">{item.version}</p>}
            <AgentResourceFooter className={PACKAGE_CARD_FOOTER_CLASS_NAME}>
              <span>{t(`sealed.status.${item.status}`, { defaultValue: t('sealed.status.unknown') })}</span>
              {item.status === 'draft' && (
                <Button size="sm" className="h-8 gap-2" disabled={publishing} onClick={() => { void handlePublish(item.packageVersionId); }}>
                  {publishing && <RefreshCw className="size-3.5 animate-spin motion-reduce:animate-none" />}
                  {t(publishing ? 'sealed.publishing' : 'sealed.publish')}
                </Button>
              )}
            </AgentResourceFooter>
          </AgentResourceCard>
        );
      })}
    </CloudPackagePanel>
  );
}

function CloudPackageCard({ packageInfo, installing, installed, onInstall }: {
  packageInfo: SealedSkillCloudPackage;
  installing: boolean;
  installed: boolean;
  onInstall: (packageInfo: SealedSkillCloudPackage) => void;
}) {
  const { t } = useTranslation('skills');
  const displayName = packageInfo.name?.trim() || packageInfo.skillKey?.trim() || packageInfo.fileName?.trim() || packageInfo.packageId || '-';

  return (
    <AgentResourceCard className="gap-3 p-4">
      <div className="flex min-w-0 items-center gap-3">
        <AgentResourceIcon className={SKILL_CARD_ICON_CLASS_NAME}><Package className="size-5" aria-hidden="true" /></AgentResourceIcon>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{displayName}</h3>
          {packageInfo.skillKey && packageInfo.skillKey !== displayName && <p className="mt-1 truncate text-xs text-muted-foreground">{packageInfo.skillKey}</p>}
        </div>
      </div>
      <p className={SKILL_CARD_DESCRIPTION_CLASS_NAME}>{packageInfo.description || t('sealed.noDescription')}</p>
      {(packageInfo.version && !isPackageDigest(packageInfo.version) || typeof packageInfo.size === 'number') && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {packageInfo.version && !isPackageDigest(packageInfo.version) && <span>{packageInfo.version}</span>}
          {typeof packageInfo.size === 'number' && <span>{t('sealed.packageSize', { size: packageInfo.size.toLocaleString() })}</span>}
        </div>
      )}
      <AgentResourceFooter className={PACKAGE_CARD_FOOTER_CLASS_NAME}>
        <span>{installed ? t('sealed.cloudInstalled') : t('sealed.cloudAvailable')}</span>
        <Button size="sm" variant="outline" className="h-8 shrink-0 gap-2" disabled={installing || installed || packageInfo.downloadable !== true} onClick={() => onInstall(packageInfo)}>
          {installing ? <RefreshCw className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Download className="size-3.5" />}
          {t('sealed.installFromCloud')}
        </Button>
      </AgentResourceFooter>
    </AgentResourceCard>
  );
}

export function CloudMarketView({ active, view, selectionCurrent }: SkillViewProps) {
  const { t } = useTranslation('skills');
  const [searchParams, setSearchParams] = useSearchParams();
  const packages = useSealedSkillsStore((state) => state.cloudPackages);
  const installedPackages = useSealedSkillsStore((state) => state.installedCloudPackages);
  const installingByPackageKey = useSealedSkillsStore((state) => state.cloudInstallingByPackageKey);
  const install = useSealedSkillsStore((state) => state.downloadAndInstallCloudSkillPackage);
  if (!active) return null;
  const query = (searchParams.get('packageSearch') || '').trim().toLowerCase();
  const filteredPackages = packages.filter((item) => [item.name, item.skillKey, item.packageId, item.fileName, item.description].some((value) => value?.toLowerCase().includes(query)));

  const handleInstall = async (packageInfo: SealedSkillCloudPackage) => {
    try {
      await install(packageInfo);
      if (!selectionCurrent()) return;
      const state = useSealedSkillsStore.getState();
      if (state.error || state.cloudError) toast.warning(t('sealed.installedRefreshFailed'));
      else toast.success(t('sealed.installedFromCloud'));
      setSearchParams((params) => {
        const next = new URLSearchParams(params);
        next.set('packageTab', 'installed');
        next.delete('packageSearch');
        return next;
      }, { replace: true });
    } catch (error) {
      if (selectionCurrent()) toast.error(sealedSkillErrorMessage(error, t, 'sealed.installFromCloudFailed'));
    }
  };

  return (
    <CloudPackagePanel panel="market" view={view} query={query}>
      {filteredPackages.map((packageInfo) => {
        const packageKey = getSealedSkillCloudPackageKey(packageInfo);
        return (
          <CloudPackageCard
            key={packageKey}
            packageInfo={packageInfo}
            installing={Boolean(installingByPackageKey[packageKey])}
            installed={installedPackages.some((item) => item.packageType === 'skill' && (item.packageVersionId === packageInfo.packageVersionId || item.packageSha256 === packageInfo.version))}
            onInstall={handleInstall}
          />
        );
      })}
    </CloudPackagePanel>
  );
}
