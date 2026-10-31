import { cn } from '@/lib/utils';
import type { AppPluginManifest } from '@/types/desktop/app-plugin';

const PALETTES = [
  'border-teal-200 bg-teal-50 text-teal-900 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-200',
  'border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-200',
  'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
  'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200',
  'border-slate-200 bg-slate-100 text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200',
];

export function PluginIdentity({ manifest, className }: {
  manifest: Pick<AppPluginManifest, 'id' | 'name'>;
  className?: string;
}) {
  const words = manifest.name.match(/[\p{L}\p{N}]+/gu) ?? manifest.id.match(/[\p{L}\p{N}]+/gu) ?? [];
  const first = Array.from(words[0] ?? '');
  const initials = words.length > 1 ? `${first[0]}${Array.from(words[1])[0]}` : first.slice(0, 2).join('');
  const monogram = manifest.name.match(/\p{Script=Han}/u)?.[0] ?? Array.from(initials.toUpperCase()).slice(0, 2).join('');
  let hash = 0;
  for (let index = 0; index < manifest.id.length; index++) {
    hash = (Math.imul(hash, 31) + manifest.id.charCodeAt(index)) >>> 0;
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative inline-flex size-12 shrink-0 select-none items-center justify-center overflow-hidden rounded-[var(--radius-interactive)] border text-xl font-semibold leading-none tracking-tight',
        'after:pointer-events-none after:absolute after:inset-[3px] after:rounded-[calc(var(--radius-interactive)-4px)] after:border after:border-current after:opacity-[0.08]',
        PALETTES[hash % PALETTES.length],
        className,
      )}
    >
      {monogram}
    </span>
  );
}
