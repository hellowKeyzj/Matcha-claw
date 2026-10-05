import type { JSX, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { WikiSurface } from './WikiChrome';

export function SettingRow(props: Readonly<{ title: string; description: string; checked: boolean; disabled: boolean; onChange(value: boolean): void }>): JSX.Element {
  return (
    <div className="flex items-center gap-4 border-b border-border/60 px-4 py-4 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{props.title}</div>
        <div className="mt-1 max-w-xl text-sm text-muted-foreground">{props.description}</div>
      </div>
      <Switch checked={props.checked} disabled={props.disabled} onCheckedChange={props.onChange} aria-label={props.title} />
    </div>
  );
}

export function SelectSettingRow(props: Readonly<{ title: string; description: string; value: string; disabled: boolean; options: readonly (readonly [string, string])[]; onChange(value: string): void }>): JSX.Element {
  const selectedLabel = props.options.find(([value]) => value === props.value)?.[1] ?? props.value;
  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-border/60 px-4 py-4 last:border-b-0">
      <div className="min-w-0 flex-1 basis-56">
        <div className="text-sm font-medium">{props.title}</div>
        <div className="mt-1 max-w-xl text-sm text-muted-foreground">{props.description}</div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" disabled={props.disabled} title={selectedLabel} aria-label={props.title} className="h-9 w-full justify-between rounded-[var(--radius-interactive)] bg-card px-3 text-sm font-normal sm:w-56">
            <span className="min-w-0 truncate">{selectedLabel}</span>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 max-h-[min(16rem,var(--radix-dropdown-menu-content-available-height))] max-w-[calc(100vw-2rem)] overflow-y-auto">
          {props.options.map(([value, label]) => (
            <DropdownMenuItem key={value} onSelect={() => props.onChange(value)}>
              <span className="truncate" title={label}>{label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function SettingGroup(props: Readonly<{ title: string; description: string; children: ReactNode }>): JSX.Element {
  return (
    <WikiSurface>
      <details className="group">
        <summary className="flex cursor-pointer select-none items-center gap-3 px-4 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{props.title}</div>
            <div className="mt-1 max-w-xl text-sm text-muted-foreground">{props.description}</div>
          </div>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none group-open:rotate-180" />
        </summary>
        <div className="border-t border-border/60">{props.children}</div>
      </details>
    </WikiSurface>
  );
}
