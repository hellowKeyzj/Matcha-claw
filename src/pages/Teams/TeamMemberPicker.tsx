import { useId, useMemo, useState } from 'react';
import { Check, Crown, RefreshCw, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { SubagentSummary } from '@/types/subagent';

export type ManualMemberDraft = {
  agentId: string;
  isLeader: boolean;
};

export function TeamMemberPicker({
  agents,
  loading,
  error,
  ready,
  members,
  onMembersChange,
  onRefresh,
}: {
  agents: SubagentSummary[];
  loading: boolean;
  error: string | null;
  ready: boolean;
  members: ManualMemberDraft[];
  onMembersChange: (members: ManualMemberDraft[]) => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation('teams');
  const pickerId = useId();
  const [searchQuery, setSearchQuery] = useState('');
  const searchText = searchQuery.trim().toLocaleLowerCase();
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const selectedAgentIds = useMemo(() => new Set(members.map((member) => member.agentId)), [members]);
  const visibleAgents = useMemo(() => searchText
    ? agents.filter((agent) => [agent.id, agent.name, agent.identity?.name, agent.workspace, ...(agent.skills ?? [])]
      .some((value) => value?.toLocaleLowerCase().includes(searchText)))
    : agents, [agents, searchText]);

  const removeMember = (agentId: string) => {
    const remaining = members.filter((member) => member.agentId !== agentId);
    const removedLeader = members.some((member) => member.agentId === agentId && member.isLeader);
    onMembersChange(removedLeader
      ? remaining.map((member, index) => ({ ...member, isLeader: index === 0 }))
      : remaining);
  };

  const toggleMember = (agentId: string) => {
    if (selectedAgentIds.has(agentId)) {
      removeMember(agentId);
      return;
    }
    onMembersChange([...members, { agentId, isLeader: members.length === 0 }]);
  };

  const selectLeader = (agentId: string) => {
    onMembersChange(members.map((member) => ({ ...member, isLeader: member.agentId === agentId })));
  };

  return (
    <div className="grid min-h-full grid-cols-1 content-start gap-7 pr-1 md:h-full md:min-h-0 md:grid-cols-[minmax(0,1.06fr)_minmax(0,1fr)] md:content-stretch md:gap-x-14 md:gap-y-0 md:overflow-hidden md:pr-0">
      <section aria-labelledby={`${pickerId}-agents`} className="relative flex min-h-0 min-w-0 flex-col">
        <div aria-hidden="true" className="absolute inset-y-0 -right-7 hidden w-px bg-border md:block" />
        <div className="flex h-8 shrink-0 items-center gap-2">
          <h3 id={`${pickerId}-agents`} className="text-sm font-semibold text-foreground">{t('create.manualAgentsTitle')}</h3>
          <span className="text-xs tabular-nums text-muted-foreground">{agents.length}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onRefresh}
            disabled={!ready || loading}
            aria-label={loading ? t('create.manualLoadingAgents') : t('create.manualRefreshAgents')}
            className="ml-auto h-8 w-8 shrink-0 text-muted-foreground"
          >
            <RefreshCw aria-hidden="true" className={cn('h-4 w-4', loading && 'animate-spin motion-reduce:animate-none')} />
          </Button>
        </div>

        <div className="relative mt-3 shrink-0">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label={t('create.manualSearch')}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('create.manualSearchPlaceholder')}
            className="h-10 bg-[hsl(var(--shell-surface-muted))] pl-9 text-sm"
          />
        </div>

        <div aria-busy={loading} className="mt-3 max-h-64 space-y-1 overflow-y-auto py-1 md:min-h-0 md:max-h-none md:flex-1">
          {error ? <p role="alert" className="px-3 py-3 text-sm text-destructive">{error}</p> : null}
          {!error && agents.length === 0 && loading ? (
            <p role="status" className="px-3 py-4 text-sm text-muted-foreground">{t('create.manualLoadingAgents')}</p>
          ) : null}
          {!error && !loading && ready && agents.length === 0 ? (
            <p role="status" className="px-3 py-4 text-sm text-muted-foreground">{t('create.manualNoAgents')}</p>
          ) : null}
          {!error && agents.length > 0 && visibleAgents.length === 0 ? (
            <p role="status" className="px-3 py-4 text-sm text-muted-foreground">{t('create.manualNoMatchingAgents')}</p>
          ) : null}
          {visibleAgents.map((agent) => {
            const selected = selectedAgentIds.has(agent.id);
            const agentName = agent.name ?? agent.identity?.name ?? agent.id;
            return (
              <Button
                key={agent.id}
                type="button"
                variant="ghost"
                role="checkbox"
                aria-checked={selected}
                aria-label={t('create.manualSelectAgentAriaLabel', { agentName })}
                onClick={() => toggleMember(agent.id)}
                className={cn(
                  'h-[54px] w-full justify-start gap-3 rounded-xl px-3 py-0 text-left font-medium text-foreground',
                  selected && 'bg-[hsl(var(--shell-surface-muted))] hover:bg-[hsl(var(--shell-surface-muted))]',
                )}
              >
                <AgentAvatar
                  avatarSeed={agent.avatarSeed}
                  avatarStyle={agent.avatarStyle}
                  agentId={agent.id}
                  agentName={agentName}
                  className="h-8 w-8"
                  alt=""
                />
                <span className="min-w-0 flex-1 truncate text-sm">{agentName}</span>
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border',
                    selected
                      ? 'border-[hsl(var(--shell-icon-active))] bg-[hsl(var(--shell-icon-active))] text-[hsl(var(--shell-window))]'
                      : 'border-[hsl(var(--shell-border-strong))] bg-[hsl(var(--shell-surface))]',
                  )}
                >
                  {selected ? <Check className="h-3 w-3" /> : null}
                </span>
              </Button>
            );
          })}
        </div>
      </section>

      <section aria-labelledby={`${pickerId}-members`} className="flex min-h-0 min-w-0 flex-col border-t border-border pt-7 md:border-t-0 md:pt-0">
        <div className="flex h-8 shrink-0 items-center justify-between gap-3">
          <h3 id={`${pickerId}-members`} className="text-sm font-semibold text-foreground">{t('create.manualSelectedTitle')}</h3>
          <span className="text-sm font-medium tabular-nums text-foreground">{members.length}</span>
        </div>
        <div className="mt-4 md:min-h-0 md:flex-1 md:overflow-y-auto">
          {members.length === 0 ? (
            <p className="py-6 text-sm leading-6 text-muted-foreground">{t('create.manualSelectedEmpty')}</p>
          ) : members.map((member) => {
            const agent = agentsById.get(member.agentId);
            const agentName = agent?.name ?? agent?.identity?.name ?? member.agentId;
            return (
              <div
                key={member.agentId}
                className={cn(
                  'flex items-center gap-3 px-3',
                  member.isLeader
                    ? 'mb-2 h-[70px] rounded-xl bg-[hsl(var(--shell-surface-muted))]'
                    : 'h-[68px] border-b border-border',
                )}
              >
                <AgentAvatar
                  avatarSeed={agent?.avatarSeed}
                  avatarStyle={agent?.avatarStyle}
                  agentId={member.agentId}
                  agentName={agentName}
                  className="h-8 w-8"
                  alt=""
                />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{agentName}</span>
                <label className="shrink-0 cursor-pointer">
                  <input
                    type="radio"
                    name={`${pickerId}-leader`}
                    value={member.agentId}
                    checked={member.isLeader}
                    aria-label={t('create.manualLeaderAriaLabel', { agentName })}
                    onChange={() => selectLeader(member.agentId)}
                    className="peer sr-only"
                  />
                  <span className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground peer-checked:border-border peer-checked:bg-background peer-checked:text-foreground peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background">
                    {member.isLeader
                      ? <Crown aria-hidden="true" className="h-3.5 w-3.5" />
                      : <span aria-hidden="true" className="h-3 w-3 rounded-full border border-current" />}
                    {t('create.manualLeader')}
                  </span>
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeMember(member.agentId)}
                  aria-label={t('create.manualRemoveAgentAriaLabel', { agentName })}
                  className="h-7 w-7 shrink-0 text-muted-foreground"
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
