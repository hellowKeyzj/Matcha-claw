import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import { defineExtensionPoint, definePlugin } from '@/plugin-host/core';

export interface PageContribution {
  id: string;
  path: string;
  component?: ComponentType;
  redirectTo?: string;
  viewport?: 'document' | 'workspace' | 'custom';
  preload?: () => Promise<unknown>;
}

export interface NavigationContribution {
  id: string;
  to: string;
  label: string;
  icon: LucideIcon;
  order: number;
  activePaths?: readonly string[];
  children?: readonly { to: string; label: string }[];
  prefetch?: () => void | Promise<unknown>;
}

export interface SettingsSectionProps {
  active: boolean;
}

export interface SettingsContribution {
  id: string;
  label: string;
  order: number;
  component: ComponentType<SettingsSectionProps>;
  layout?: 'document' | 'workspace';
  keepMounted?: boolean;
}

export interface ApplicationLifecycleProps {
  hostReady: boolean;
  contentVisible: boolean;
}

export interface ComponentContribution<P = object> {
  id: string;
  component: ComponentType<P>;
  order: number;
}

export const applicationPages = defineExtensionPoint<PageContribution>('app.pages');
export const applicationNavigation = defineExtensionPoint<NavigationContribution>('app.navigation');
export const applicationSettings = defineExtensionPoint<SettingsContribution>('app.settings');
export const applicationLifecycle = defineExtensionPoint<ComponentContribution<ApplicationLifecycleProps>>('app.lifecycle');
export const sidebarActions = defineExtensionPoint<ComponentContribution>('app.sidebar.actions');
export const sidebarPanels = defineExtensionPoint<ComponentContribution>('app.sidebar.panels');
export const sidebarFooter = defineExtensionPoint<ComponentContribution>('app.sidebar.footer');

export const applicationShellPlugin = definePlugin({
  id: 'app-shell',
  extensionPoints: [applicationPages, applicationNavigation, applicationSettings, applicationLifecycle, sidebarActions, sidebarPanels, sidebarFooter],
});
