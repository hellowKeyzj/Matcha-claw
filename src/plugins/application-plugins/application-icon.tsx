import { AppWindow, createLucideIcon, type LucideIcon } from 'lucide-react';
import type { AppApplicationIcon } from '@/types/desktop/app-plugin';

export function applicationIcon(icon: AppApplicationIcon | undefined): LucideIcon {
  return icon ? createLucideIcon('Application', icon.paths.map((d, index) => ['path', { d, key: String(index) }])) : AppWindow;
}
