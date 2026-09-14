import { LayoutGrid, List } from 'lucide-react';
import { cn } from '@/lib/utils';

export function AgentViewToggle({
  value,
  onChange,
  gridLabel,
  listLabel,
}: {
  value: 'grid' | 'list';
  onChange: (value: 'grid' | 'list') => void;
  gridLabel: string;
  listLabel: string;
}) {
  return (
    <div className="inline-flex shrink-0 gap-1 rounded-lg border border-border p-1">
      {([
        ['grid', LayoutGrid, gridLabel],
        ['list', List, listLabel],
      ] as const).map(([view, Icon, label]) => (
        <button
          key={view}
          type="button"
          aria-label={label}
          aria-pressed={value === view}
          title={label}
          onClick={() => onChange(view)}
          className={cn(
            'flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
            value === view && 'bg-accent text-foreground',
          )}
        >
          <Icon className="size-4" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
