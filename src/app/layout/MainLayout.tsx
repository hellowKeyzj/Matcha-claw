/**
 * Main Layout Component
 * TitleBar at top, then layout panes below.
 */
import { useEffect, useMemo } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';
import { NAVIGATION_RAIL_WIDTH } from './workspace';
import { invokeIpc } from '@/lib/api-client';
import { StableScrollArea } from '@/components/scroll';
import { useLayoutStore } from './store';
import { useLocalLicenseLocked } from '@/plugins/account/stores/license';
import { applicationPages } from '@/app/extensions';
import { resolvePageContribution } from '@/app/routes';
import { useContributions } from '@/plugin-host/react';

const PAGE_VIEWPORT_CLASS_NAME = {
  document: 'h-full overflow-auto overscroll-contain bg-[hsl(var(--shell-surface))] px-5 py-4 [scrollbar-gutter:stable] md:px-8 md:py-6',
  workspace: 'h-full overflow-auto overscroll-contain bg-[hsl(var(--shell-surface))] [scrollbar-gutter:stable]',
};

export function MainLayout() {
  const location = useLocation();
  const viewportTakeover = useLayoutStore((state) => state.viewportTakeover);
  const viewportRightDockLayout = useLayoutStore((state) => state.viewportRightDockLayout);
  const clearViewportTakeover = useLayoutStore((state) => state.clearViewportTakeover);
  const licenseLocked = useLocalLicenseLocked();
  const pages = useContributions(applicationPages);
  const pageViewportMode = useMemo(() => (
    resolvePageContribution(pages, location.pathname)?.viewport ?? 'document'
  ), [pages, location.pathname]);
  const customViewportActive = !licenseLocked && pageViewportMode === 'custom';
  const viewportTakeoverActive = customViewportActive && viewportTakeover;
  const activeRightDockLayout = customViewportActive ? viewportRightDockLayout : null;
  // The Chat Host owns the sessions column inside main; only the global rail sits outside it.
  const viewportMainFlexWidth = activeRightDockLayout && activeRightDockLayout.dockWidth > 0
    ? Math.max(1, activeRightDockLayout.baseWidth - (viewportTakeoverActive ? 0 : NAVIGATION_RAIL_WIDTH) + activeRightDockLayout.dockWidth)
    : null;
  const mainStyle = viewportMainFlexWidth == null
    ? undefined
    : { flex: `0 0 ${viewportMainFlexWidth}px` };

  useEffect(() => {
    if (customViewportActive) {
      return;
    }
    clearViewportTakeover();
  }, [clearViewportTakeover, customViewportActive]);

  useEffect(() => {
    if (window.electron?.platform !== 'darwin') {
      return;
    }
    void invokeIpc('window:syncTrafficLightPosition', viewportTakeoverActive);
  }, [viewportTakeoverActive]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[hsl(var(--shell-window))]">
      <TitleBar />

      <div className="relative flex min-h-0 flex-1 overflow-hidden bg-[hsl(var(--shell-surface))]">
        {!viewportTakeoverActive ? <Sidebar /> : null}
        <main className="min-w-0 flex-1 overflow-hidden bg-[hsl(var(--shell-surface))]" style={mainStyle}>
          {pageViewportMode === 'custom' ? (
            <Outlet />
          ) : (
            <StableScrollArea
              data-page-scroll
              className={PAGE_VIEWPORT_CLASS_NAME[pageViewportMode]}
            >
              <Outlet />
            </StableScrollArea>
          )}
        </main>
      </div>
    </div>
  );
}
