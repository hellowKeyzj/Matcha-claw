/**
 * Sidebar Component
 * Navigation sidebar with menu items.
 */
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Suspense, startTransition, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { NAVIGATION_RAIL_WIDTH } from './workspace';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useLocalLicenseLocked } from '@/plugins/account/stores/license';
import { useContributions, usePluginHost } from '@/plugin-host/react';
import type { ExtensionPoint } from '@/plugin-host/core';
import {
  applicationNavigation,
  sidebarActions,
  sidebarPanels,
  sidebarFooter,
  type ComponentContribution,
  type NavigationContribution,
} from '@/app/extensions';
import { preloadApplicationPath } from '@/app/navigation';

interface NavItemProps {
  to: string;
  icon: ReactNode;
  label: string;
  active?: boolean;
  end?: boolean;
  disabled?: boolean;
  onMouseEnter?: () => void;
  onFocus?: () => void;
  onNavigate?: (to: string) => void;
}

const NAV_ITEM_CLASS_NAME = 'group flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-[background-color,color] hover:bg-[hsl(var(--shell-surface-hover))] hover:text-[hsl(var(--shell-icon-active))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45';

const SIDEBAR_PREFETCH_FALLBACK_DELAY_MS = 120;
const SIDEBAR_PREFETCH_IDLE_TIMEOUT_MS = 400;

type PrefetchScheduleHandle =
  | { type: 'idle'; id: number }
  | { type: 'timeout'; id: number };

function NavItem({ to, icon, label, active, end, disabled, onMouseEnter, onFocus, onNavigate }: NavItemProps) {
  if (disabled) {
    return (
      <button type="button" disabled title={label} aria-label={label} className={cn(NAV_ITEM_CLASS_NAME, 'text-[hsl(var(--shell-text-muted))]')}>
        <span aria-hidden="true">{icon}</span>
      </button>
    );
  }
  return (
    <NavLink
      to={to}
      end={end}
      title={label}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      onMouseEnter={onMouseEnter}
      onFocus={onFocus}
      onClick={(event) => {
        if (!onNavigate) {
          return;
        }
        if (
          event.defaultPrevented
          || event.button !== 0
          || event.metaKey
          || event.ctrlKey
          || event.shiftKey
          || event.altKey
        ) {
          return;
        }
        event.preventDefault();
        onNavigate(to);
      }}
      className={({ isActive }) =>
        cn(
          NAV_ITEM_CLASS_NAME,
          (active ?? isActive)
            ? 'bg-[hsl(var(--shell-surface-active))] text-[hsl(var(--shell-icon-active))]'
            : 'text-[hsl(var(--shell-text-muted))]',
        )
      }
    >
      <span aria-hidden="true">{icon}</span>
    </NavLink>
  );
}

function SidebarSlot({ point }: { point: ExtensionPoint<ComponentContribution> }) {
  const contributions = useContributions(point);
  const ordered = useMemo(() => [...contributions].sort((a, b) => a.order - b.order), [contributions]);
  return ordered.map(({ id, component: Component }) => (
    <Suspense key={id} fallback={null}><Component /></Suspense>
  ));
}

function NavigationItem({ item, pathname, disabled, onPrefetch, onNavigate }: {
  item: NavigationContribution;
  pathname: string;
  disabled: boolean;
  onPrefetch: (path: string) => void;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const isActive = pathname === item.to || pathname.startsWith(`${item.to}/`) || item.activePaths?.includes(pathname) === true;
  const Icon = item.icon;

  if (!item.children?.length) {
    return (
      <NavItem
        to={item.to}
        icon={<Icon className="h-[17px] w-[17px]" />}
        label={t(item.label)}
        disabled={disabled}
        active={item.activePaths?.includes(pathname) ? true : undefined}
        onMouseEnter={() => onPrefetch(item.to)}
        onFocus={() => onPrefetch(item.to)}
        onNavigate={onNavigate}
      />
    );
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={t(item.label)}
          aria-label={t(item.label)}
          onMouseEnter={() => onPrefetch(item.to)}
          onFocus={() => onPrefetch(item.to)}
          className={cn(
            NAV_ITEM_CLASS_NAME,
            isActive
              ? 'bg-[hsl(var(--shell-surface-active))] text-[hsl(var(--shell-icon-active))]'
              : 'text-[hsl(var(--shell-text-muted))]',
          )}
        >
          <Icon aria-hidden="true" className="h-[17px] w-[17px]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" aria-label={t(item.label)}>
        {item.children.map((page) => (
          <DropdownMenuItem key={page.to} asChild>
            <NavLink
              to={page.to}
              end
              onMouseEnter={() => onPrefetch(page.to)}
              onFocus={() => onPrefetch(page.to)}
              className={cn(pathname === page.to && 'bg-accent text-accent-foreground')}
            >
              {t(page.label)}
            </NavLink>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  const host = usePluginHost();
  const navigation = useContributions(applicationNavigation);
  const navItems = useMemo(() => [...navigation].sort((a, b) => a.order - b.order), [navigation]);
  const licenseLocked = useLocalLicenseLocked();
  const prefetchHandlesRef = useRef<Map<string, PrefetchScheduleHandle>>(new Map());
  const navigate = useNavigate();
  const location = useLocation();

  const clearPrefetchHandle = useCallback((path: string) => {
    const current = prefetchHandlesRef.current.get(path);
    if (!current) {
      return;
    }
    if (current.type === 'idle') {
      if ('cancelIdleCallback' in window && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(current.id);
      }
    } else {
      window.clearTimeout(current.id);
    }
    prefetchHandlesRef.current.delete(path);
  }, []);

  const scheduleNavPrefetch = useCallback((path: string) => {
    if (licenseLocked || prefetchHandlesRef.current.has(path)) {
      return;
    }

    const runPrefetch = () => {
      prefetchHandlesRef.current.delete(path);
      void preloadApplicationPath(host, path);
    };

    if ('requestIdleCallback' in window && typeof window.requestIdleCallback === 'function') {
      const idleId = window.requestIdleCallback(runPrefetch, { timeout: SIDEBAR_PREFETCH_IDLE_TIMEOUT_MS });
      prefetchHandlesRef.current.set(path, { type: 'idle', id: idleId });
      return;
    }

    const timeoutId = window.setTimeout(runPrefetch, SIDEBAR_PREFETCH_FALLBACK_DELAY_MS);
    prefetchHandlesRef.current.set(path, { type: 'timeout', id: timeoutId });
  }, [host, licenseLocked]);

  useEffect(() => () => {
    const paths = Array.from(prefetchHandlesRef.current.keys());
    for (const path of paths) {
      clearPrefetchHandle(path);
    }
  }, [clearPrefetchHandle, host, licenseLocked]);

  const navigateToPath = useCallback((to: string) => {
    if (location.pathname === to) {
      return;
    }
    startTransition(() => {
      navigate(to);
    });
  }, [location.pathname, navigate]);

  return (
    <aside
      className="flex h-full shrink-0 flex-col overflow-hidden bg-[hsl(var(--shell-surface-muted))]"
      style={{ width: NAVIGATION_RAIL_WIDTH }}
    >
      <nav aria-label={t('common:sidebar.navigation')} className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden px-[7px] py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <SidebarSlot point={sidebarActions} />
        {navItems.map((item) => (
          <NavigationItem
            key={item.id}
            item={item}
            pathname={location.pathname}
            disabled={licenseLocked}
            onPrefetch={scheduleNavPrefetch}
            onNavigate={navigateToPath}
          />
        ))}
        {!licenseLocked && <SidebarSlot point={sidebarPanels} />}
      </nav>

      <div className="flex shrink-0 flex-col items-center gap-1.5 px-[7px] pb-2 pt-1">
        <SidebarSlot point={sidebarFooter} />
      </div>
    </aside>
  );
}
