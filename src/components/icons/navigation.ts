import { createLucideIcon } from 'lucide-react';

// Shared 24px grid; translucent currentColor fills follow both shell themes.
export const ChatNavigationIcon = createLucideIcon('ChatNavigation', [
  ['path', { d: 'M7 4h10a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4H8l-4.5 2V8A4 4 0 0 1 7 4Z', fill: 'currentColor', fillOpacity: '0.08', key: 'bubble' }],
  ['path', { d: 'M8 9h8M8 13h5', key: 'message' }],
]);

export const TasksNavigationIcon = createLucideIcon('TasksNavigation', [
  ['rect', { x: '4.5', y: '4.5', width: '15', height: '17', rx: '3', fill: 'currentColor', fillOpacity: '0.08', key: 'sheet' }],
  ['rect', { x: '8', y: '2.5', width: '8', height: '4', rx: '1.5', fill: 'currentColor', stroke: 'none', key: 'clip' }],
  ['path', { d: 'm8 11 1.25 1.25L11.5 10M14 11h2M8 16h2M14 16h2', key: 'tasks' }],
]);

export const AgentNavigationIcon = createLucideIcon('AgentNavigation', [
  ['rect', { x: '4.5', y: '7', width: '15', height: '14', rx: '4', fill: 'currentColor', fillOpacity: '0.08', key: 'head' }],
  ['path', { d: 'M12 7V3M2.5 12v4M21.5 12v4', key: 'antenna' }],
  ['circle', { cx: '9', cy: '12', r: '1', fill: 'currentColor', stroke: 'none', key: 'left-eye' }],
  ['circle', { cx: '15', cy: '12', r: '1', fill: 'currentColor', stroke: 'none', key: 'right-eye' }],
  ['path', { d: 'M9.5 16.5h5', key: 'mouth' }],
]);

export const TeamNavigationIcon = createLucideIcon('TeamNavigation', [
  ['circle', { cx: '9', cy: '7.5', r: '3.5', fill: 'currentColor', fillOpacity: '0.12', key: 'person' }],
  ['path', { d: 'M3 20v-1.5A4.5 4.5 0 0 1 7.5 14h3a4.5 4.5 0 0 1 4.5 4.5V20Z', fill: 'currentColor', fillOpacity: '0.08', key: 'body' }],
  ['path', { d: 'M16 4.5a3 3 0 0 1 0 6M18 14a4 4 0 0 1 3 4v2h-2', key: 'teammate' }],
]);

export const ModelNavigationIcon = createLucideIcon('ModelNavigation', [
  ['path', { d: 'M12 5.5c0-3.5-5-3.5-5.5 0-3 0-4.5 3.5-2.5 6-2.5 3-.5 6.5 2 6.5 0 4 6 4 6 0 0 4 6 4 6 0 2.5 0 4.5-3.5 2-6 2-2.5.5-6-2.5-6-.5-3.5-5.5-3.5-5.5 0Z', fill: 'currentColor', fillOpacity: '0.08', key: 'brain' }],
  ['path', { d: 'M12 5.5V18M6.5 5.5C6.5 7 7.5 8 9 8M17.5 5.5C17.5 7 16.5 8 15 8', key: 'lobes' }],
  ['path', { d: 'M4 11.5h2.5A2.5 2.5 0 0 1 9 14M20 11.5h-2.5A2.5 2.5 0 0 0 15 14', key: 'folds' }],
]);

export const ChannelsNavigationIcon = createLucideIcon('ChannelsNavigation', [
  ['path', { d: 'M6 3.5h7A3.5 3.5 0 0 1 16.5 7v4a3.5 3.5 0 0 1-3.5 3.5H7l-4.5 2V7A3.5 3.5 0 0 1 6 3.5Z', fill: 'currentColor', fillOpacity: '0.08', key: 'front' }],
  ['path', { d: 'M19.5 8.5a3.5 3.5 0 0 1 2 3.2V21L17 19h-4a3.5 3.5 0 0 1-3.2-2', key: 'back' }],
  ['path', { d: 'M7 8.5h5', key: 'message' }],
]);

export const WikiNavigationIcon = createLucideIcon('WikiNavigation', [
  ['path', { d: 'M12 6.5C9.5 4.5 6.5 4 3 4.5v14c3.5-.5 6.5 0 9 2 2.5-2 5.5-2.5 9-2v-14c-3.5-.5-6.5 0-9 2Z', fill: 'currentColor', fillOpacity: '0.08', key: 'book' }],
  ['path', { d: 'M12 6.5v14M6.5 8.5l2 .5M6.5 12l2 .5M15.5 9l2-.5M15.5 12.5l2-.5', key: 'pages' }],
]);

export const DashboardNavigationIcon = createLucideIcon('DashboardNavigation', [
  ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '4', fill: 'currentColor', fillOpacity: '0.08', key: 'panel' }],
  ['path', { d: 'M7.5 16.5v-3M12 16.5v-6M16.5 16.5v-9', key: 'bars' }],
]);

export const AppsNavigationIcon = createLucideIcon('AppsNavigation', [
  ['rect', { x: '3.5', y: '3.5', width: '6.5', height: '6.5', rx: '2', fill: 'currentColor', fillOpacity: '0.16', key: 'top-left' }],
  ['rect', { x: '14', y: '3.5', width: '6.5', height: '6.5', rx: '2', fill: 'currentColor', fillOpacity: '0.08', key: 'top-right' }],
  ['rect', { x: '3.5', y: '14', width: '6.5', height: '6.5', rx: '2', fill: 'currentColor', fillOpacity: '0.08', key: 'bottom-left' }],
  ['rect', { x: '14', y: '14', width: '6.5', height: '6.5', rx: '2', fill: 'currentColor', fillOpacity: '0.08', key: 'bottom-right' }],
]);

export const ConsoleNavigationIcon = createLucideIcon('ConsoleNavigation', [
  ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '3.5', fill: 'currentColor', fillOpacity: '0.08', key: 'window' }],
  ['path', { d: 'm7 9 3 3-3 3M13.5 15h3.5', key: 'prompt' }],
]);
