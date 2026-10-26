/**
 * Sidebar Component
 * Navigation sidebar with menu items.
 */
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { Suspense, startTransition, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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

interface SidebarProps {
  width?: number;
  overlay?: boolean;
  showRightDivider?: boolean;
}

const SIDEBAR_PREFETCH_FALLBACK_DELAY_MS = 120;
const SIDEBAR_PREFETCH_IDLE_TIMEOUT_MS = 400;

type PrefetchScheduleHandle =
  | { type: 'idle'; id: number }
  | { type: 'timeout'; id: number };

function NavItem({ to, icon, label, active, end, disabled, onMouseEnter, onFocus, onNavigate }: NavItemProps) {
  if (disabled) {
    return (
      <button type="button" disabled className="flex items-center gap-2.5 rounded-[12px] px-2.5 py-2 text-left text-[13px] font-medium text-[hsl(var(--shell-text-muted))] opacity-45">
        {icon && <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">{icon}</span>}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
    );
  }
  return (
    <NavLink
      to={to}
      end={end}
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
          'group flex items-center gap-2.5 rounded-[12px] px-2.5 py-2 text-[13px] font-medium tracking-[-0.01em] transition-[background-color,color]',
          'hover:bg-[hsl(var(--shell-surface-hover))] hover:text-[hsl(var(--shell-icon-active))]',
          (active ?? isActive)
            ? 'bg-[hsl(var(--shell-surface-active))] text-[hsl(var(--shell-icon-active))]'
            : 'text-[hsl(var(--shell-text-muted))]',
        )
      }
    >
      {icon && <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-[hsl(var(--shell-icon))] transition-colors group-hover:text-[hsl(var(--shell-icon-active))] group-aria-[current=page]:text-[hsl(var(--shell-icon-active))]">
        {icon}
      </span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
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
  const [expansion, setExpansion] = useState<{ path: string; expanded: boolean } | null>(null);
  const isActive = pathname === item.to || pathname.startsWith(`${item.to}/`) || item.activePaths?.includes(pathname) === true;
  const expanded = expansion?.path === pathname ? expansion.expanded : isActive;
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

  const childrenId = `sidebar-${item.id}-pages`;
  return (
    <div className="shrink-0 space-y-1">
      <button
        type="button"
        disabled={disabled}
        aria-expanded={expanded}
        aria-controls={childrenId}
        onClick={() => setExpansion({ path: pathname, expanded: !expanded })}
        onMouseEnter={() => onPrefetch(item.to)}
        onFocus={() => onPrefetch(item.to)}
        className={cn(
          'group flex w-full items-center gap-2.5 rounded-[12px] px-2.5 py-2 text-left text-[13px] font-medium tracking-[-0.01em] transition-[background-color,color]',
          'hover:bg-[hsl(var(--shell-surface-hover))] hover:text-[hsl(var(--shell-icon-active))] disabled:pointer-events-none disabled:opacity-45',
          isActive ? 'text-[hsl(var(--shell-icon-active))]' : 'text-[hsl(var(--shell-text-muted))]',
        )}
      >
        <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center"><Icon className="h-[17px] w-[17px]" /></span>
        <span className="min-w-0 flex-1 truncate">{t(item.label)}</span>
        <ChevronRight aria-hidden="true" className={cn('h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none', expanded && 'rotate-90')} />
      </button>
      <div id={childrenId} hidden={!expanded} className="ml-7 space-y-0.5">
        {item.children.map((page) => (
          <NavItem
            key={page.to}
            to={page.to}
            icon={null}
            label={t(page.label)}
            end
            disabled={disabled}
            onMouseEnter={() => onPrefetch(page.to)}
            onFocus={() => onPrefetch(page.to)}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
}

export function Sidebar({
  width = 256,
  overlay = false,
  showRightDivider = true,
}: SidebarProps) {
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
      className={cn(
        'relative flex h-full shrink-0 flex-col overflow-hidden bg-[hsl(var(--shell-surface))]',
        showRightDivider && 'border-r [border-right-color:hsl(var(--shell-border))]',
        overlay && 'shadow-[0_18px_60px_hsl(var(--shell-shadow-overlay))]',
      )}
      style={{ width }}
    >
      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2.5">
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

      <div className="space-y-1.5 p-2.5 pt-0">
        <SidebarSlot point={sidebarFooter} />
      </div>
    </aside>
  );
}
