import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

type Props = {
  id?: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
};

export function SearchSelect({ id, label, value, options, onValueChange, placeholder, disabled, className }: Props) {
  return <Select.Root value={value} onValueChange={onValueChange} disabled={disabled}>
    <Select.Trigger id={id} aria-label={label} className={cn('network-search-select flex h-10 min-w-0 items-center justify-between gap-3 rounded-[var(--radius-interactive)] border border-border bg-[hsl(var(--shell-surface))] px-3 text-sm text-foreground outline-none transition-colors hover:bg-[hsl(var(--shell-surface-hover))] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-50', className)}>
      <span className="min-w-0 truncate"><Select.Value placeholder={placeholder} /></span>
      <Select.Icon asChild><ChevronDown aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" /></Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Content position="popper" sideOffset={4} collisionPadding={12} aria-label={label} className="network-search-select-menu z-50 min-w-[var(--radix-select-trigger-width)] max-h-[min(20rem,var(--radix-select-content-available-height))] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-elevated">
        <Select.Viewport className="select-scroll-viewport max-h-[inherit] overflow-y-auto overscroll-contain p-1.5">
          {options.map((option) => <Select.Item key={option.value} value={option.value} className="relative flex cursor-default select-none items-center rounded-lg py-2 pl-3 pr-9 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground">
            <Select.ItemText>{option.label}</Select.ItemText>
            <Select.ItemIndicator className="absolute right-3"><Check aria-hidden className="h-4 w-4" /></Select.ItemIndicator>
          </Select.Item>)}
        </Select.Viewport>
      </Select.Content>
    </Select.Portal>
  </Select.Root>;
}
