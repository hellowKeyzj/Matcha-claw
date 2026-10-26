import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AgentPageToolbar } from '@/components/common/AgentPage';
import { AgentViewToggle } from '@/components/common/AgentViewToggle';
import { Input } from '@/components/ui/input';

interface SubagentResourceToolbarProps {
  search: string;
  onSearchChange: (value: string) => void;
  searchLabel: string;
  countLabel: string;
  view: 'grid' | 'list';
  onViewChange: (view: 'grid' | 'list') => void;
  children?: ReactNode;
}

export function SubagentResourceToolbar({
  search,
  onSearchChange,
  searchLabel,
  countLabel,
  view,
  onViewChange,
  children,
}: SubagentResourceToolbarProps) {
  const { t } = useTranslation('subagents');
  return (
    <AgentPageToolbar>
      <div className="relative w-full sm:w-72">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          aria-label={searchLabel}
          placeholder={searchLabel}
          className="h-10 pl-9 text-sm"
        />
      </div>
      {children}
      <div className="ml-auto flex items-center gap-4">
        <span className="text-xs text-muted-foreground" aria-live="polite">{countLabel}</span>
        <AgentViewToggle value={view} onChange={onViewChange} gridLabel={t('view.grid')} listLabel={t('view.list')} />
      </div>
    </AgentPageToolbar>
  );
}
