import { Suspense, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { applicationSettings } from '@/app/extensions';
import { useContributions } from '@/plugin-host/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useLocalLicenseLocked } from '@/plugins/account/stores/license';
import { cn } from '@/lib/utils';
import { DEFAULT_SETTINGS_SECTION, parseSettingsSectionFromSearch } from './sections';

export function Settings() {
  const { t } = useTranslation(['settings', 'common']);
  const location = useLocation();
  const navigate = useNavigate();
  const licenseLocked = useLocalLicenseLocked();
  const contributions = useContributions(applicationSettings);
  const sections = useMemo(() => [...contributions].sort((a, b) => a.order - b.order), [contributions]);
  const activeSection = licenseLocked
    ? 'license'
    : parseSettingsSectionFromSearch(location.search, sections) ?? DEFAULT_SETTINGS_SECTION;
  const workspace = sections.find((section) => section.id === activeSection)?.layout === 'workspace';

  const switchSection = useCallback((section: string) => {
    if (licenseLocked && section !== 'license') return;
    const params = new URLSearchParams(location.search);
    params.set('section', section);
    navigate({ pathname: location.pathname, search: `?${params.toString()}` }, { replace: true });
  }, [licenseLocked, location.pathname, location.search, navigate]);

  return (
    <div className={cn('flex flex-col gap-6 text-foreground', workspace && 'min-h-0 lg:h-full')} data-testid="settings-page">
      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.035em] text-foreground">{t('title')}</h1>
      </div>
      <div className={cn('grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]', workspace && 'min-h-0 flex-1')}>
        <Card className="h-fit bg-[hsl(var(--shell-surface-muted))] [border-color:hsl(var(--shell-border))]">
          <CardContent className="p-2.5">
            <nav className="space-y-1" aria-label={t('title')}>
              {sections.map((section) => (
                <Button
                  key={section.id}
                  type="button"
                  variant="ghost"
                  className={`w-full h-10 justify-start rounded-lg px-2.5 text-sm font-medium transition-colors border border-transparent ${
                    activeSection === section.id
                      ? 'bg-[hsl(var(--shell-surface))] text-foreground [border-color:hsl(var(--shell-border))]'
                      : 'text-[hsl(var(--shell-text-muted))] hover:bg-[hsl(var(--shell-surface-hover))] hover:text-foreground'
                  }`}
                  disabled={licenseLocked && section.id !== 'license'}
                  onClick={() => switchSection(section.id)}
                >
                  <span
                    aria-hidden
                    className={`mr-2 h-1.5 w-1.5 rounded-full transition-colors ${activeSection === section.id ? 'bg-primary' : 'bg-transparent'}`}
                  />
                  <span className="truncate">{t(section.label)}</span>
                </Button>
              ))}
            </nav>
          </CardContent>
        </Card>
        <div className={workspace ? 'flex h-[640px] min-h-0 min-w-0 flex-col lg:h-auto' : 'min-w-0 space-y-6'}>
          {sections.map((section) => {
            const active = section.id === activeSection;
            if (!active && !section.keepMounted) return null;
            const Section = section.component;
            return (
              <div
                key={section.id}
                hidden={!active}
                className={!active ? 'hidden' : section.layout === 'workspace' ? 'flex min-h-0 flex-1 flex-col' : 'space-y-6'}
              >
                <Suspense fallback={active ? <p role="status" className="text-sm text-muted-foreground">{t('common:status.loading')}</p> : null}>
                  <Section active={active} />
                </Suspense>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default Settings;
