import { memo, useCallback, useDeferredValue, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { ShieldCheck } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useChatStore, type ApprovalItem, type ChatStoreState } from '@/plugins/chat/store';
import { resolveSessionNavigationTitle, selectPendingApprovalsBySession } from '@/plugins/chat/session-status';
import { useTeamApprovalProjection } from '@/plugins/teams/approval-projection';
import { TEAMS_FEATURE_ENABLED } from '@/plugins/teams/feature-flag';
import type { TeamApprovalRecord } from '@/plugins/teams/services/team-runtime-client';

const SIDEBAR_BLOCKER_RENDER_LIMIT = 8;
const TEAM_APPROVAL_SCAN_LIMIT = 80;
const TEAM_APPROVAL_CARD_LIMIT = 3;
const CHAT_APPROVAL_SCAN_LIMIT = 24;

interface PendingBlockerCard {
  id: string;
  source: 'team_approval' | 'chat_approval';
  teamId: string;
  teamName: string;
  title: string;
  content: string;
  from: string;
  createdAt: number;
  sessionKey?: string;
}

const EMPTY_TEAM_APPROVALS: TeamApprovalRecord[] = [];
const EMPTY_APPROVAL_ITEMS: ApprovalItem[] = [];
const teamApprovalCardsCacheByApprovalsRef = new WeakMap<TeamApprovalRecord[], Map<string, PendingBlockerCard[]>>();
const approvalCardsCacheByApprovalsRef = new WeakMap<ApprovalItem[], Map<string, PendingBlockerCard[]>>();

function formatMessageTime(createdAt: number): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    return '-';
  }
  return new Date(createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function buildTeamApprovalBlockerCards(input: {
  teamId: string;
  teamName: string;
  approvals: TeamApprovalRecord[];
  t: (key: string, options?: Record<string, unknown>) => string;
}): PendingBlockerCard[] {
  if (input.approvals.length === 0) {
    return [];
  }
  const cards: PendingBlockerCard[] = [];
  const startIndex = Math.max(0, input.approvals.length - TEAM_APPROVAL_SCAN_LIMIT);

  for (let index = input.approvals.length - 1; index >= startIndex; index -= 1) {
    if (cards.length >= TEAM_APPROVAL_CARD_LIMIT) {
      break;
    }
    const approval = input.approvals[index];
    if (approval.status !== 'pending') {
      continue;
    }
    cards.push({
      id: `team:${input.teamId}:${approval.approvalId}`,
      source: 'team_approval',
      teamId: input.teamId,
      teamName: input.teamName,
      title: input.t('sidebar.pendingBlockerStage', { stageId: approval.stageId }),
      content: approval.requestedAction || approval.reason,
      from: approval.roleId,
      createdAt: approval.createdAt,
    });
  }

  return cards;
}

function buildApprovalBlockerCards(input: {
  sessionKey: string;
  approvals: ApprovalItem[];
  sessionLabel: string;
  approvalTitlePrefix: string;
  approvalHint: string;
}): PendingBlockerCard[] {
  if (input.approvals.length === 0) {
    return [];
  }
  const cards: PendingBlockerCard[] = [];
  const startIndex = Math.max(0, input.approvals.length - CHAT_APPROVAL_SCAN_LIMIT);
  for (let index = input.approvals.length - 1; index >= startIndex; index -= 1) {
    const approval = input.approvals[index];
    cards.push({
      id: `chat-approval:${approval.id}`,
      source: 'chat_approval',
      teamId: '',
      teamName: input.sessionLabel,
      title: `${input.approvalTitlePrefix} · ${approval.title}`,
      content: approval.command ?? input.approvalHint,
      from: approval.id,
      createdAt: approval.createdAtMs,
      sessionKey: input.sessionKey,
    });
  }
  return cards;
}

const SidebarPendingBlockers = memo(function SidebarPendingBlockers() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const teams = useTeamApprovalProjection((state) => state.teams);
  const approvalsByTeamId = useTeamApprovalProjection((state) => state.approvalsByTeamId);
  const setActiveTeam = useTeamApprovalProjection((state) => state.setActiveTeam);
  const pendingApprovalsBySession = useChatStore(selectPendingApprovalsBySession);
  const deferredTeams = useDeferredValue(teams);
  const deferredApprovalsByTeamId = useDeferredValue(approvalsByTeamId);
  const deferredPendingApprovalsBySession = useDeferredValue(pendingApprovalsBySession);

  const teamApprovalCards = useMemo(() => {
    if (!TEAMS_FEATURE_ENABLED) {
      return [];
    }

    const cards: PendingBlockerCard[] = [];

    for (const team of deferredTeams) {
      const approvals = deferredApprovalsByTeamId[team.id] ?? EMPTY_TEAM_APPROVALS;
      let variants = teamApprovalCardsCacheByApprovalsRef.get(approvals);
      if (!variants) {
        variants = new Map<string, PendingBlockerCard[]>();
        teamApprovalCardsCacheByApprovalsRef.set(approvals, variants);
      }
      const variantKey = `${team.id}|${team.name}|${i18n.language}`;
      let teamCards = variants.get(variantKey);
      if (!teamCards) {
        teamCards = buildTeamApprovalBlockerCards({
          teamId: team.id,
          teamName: team.name,
          approvals,
          t,
        });
        variants.set(variantKey, teamCards);
      }
      if (teamCards.length > 0) {
        cards.push(...teamCards);
      }
    }

    return cards;
  }, [deferredApprovalsByTeamId, deferredTeams, i18n.language, t]);

  const approvalCards = useMemo(() => {
    const cards: PendingBlockerCard[] = [];
    let approvalCardsCount = 0;
    const approvalTitlePrefix = t('sidebar.pendingBlockerTypeApproval');
    const approvalHint = t('sidebar.pendingBlockerApprovalHint');

    for (const [sessionKey, approvalItems] of Object.entries(deferredPendingApprovalsBySession)) {
      if (approvalCardsCount >= CHAT_APPROVAL_SCAN_LIMIT) {
        break;
      }
      const approvals = approvalItems ?? EMPTY_APPROVAL_ITEMS;
      const sessionLabel = sessionKey;
      let variants = approvalCardsCacheByApprovalsRef.get(approvals);
      if (!variants) {
        variants = new Map<string, PendingBlockerCard[]>();
        approvalCardsCacheByApprovalsRef.set(approvals, variants);
      }
      const variantKey = `${sessionKey}|${sessionLabel}|${i18n.language}|${approvalTitlePrefix}|${approvalHint}`;
      let sessionCards = variants.get(variantKey);
      if (!sessionCards) {
        sessionCards = buildApprovalBlockerCards({
          sessionKey,
          approvals,
          sessionLabel,
          approvalTitlePrefix,
          approvalHint,
        });
        variants.set(variantKey, sessionCards);
      }
      if (sessionCards.length === 0) {
        continue;
      }
      const remain = CHAT_APPROVAL_SCAN_LIMIT - approvalCardsCount;
      if (sessionCards.length <= remain) {
        cards.push(...sessionCards);
        approvalCardsCount += sessionCards.length;
      } else {
        cards.push(...sessionCards.slice(0, remain));
        approvalCardsCount += remain;
      }
    }
    return cards;
  }, [
    deferredPendingApprovalsBySession,
    i18n.language,
    t,
  ]);

  const visibleBlockers = useMemo<PendingBlockerCard[]>(() => {
    return [...teamApprovalCards, ...approvalCards]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, SIDEBAR_BLOCKER_RENDER_LIMIT);
  }, [approvalCards, teamApprovalCards]);

  const selectSessionTitles = useCallback((state: ChatStoreState) => {
    const titles: Record<string, string> = {};
    for (const card of visibleBlockers) {
      const sessionKey = card.sessionKey;
      if (card.source !== 'chat_approval' || !sessionKey || titles[sessionKey] !== undefined) {
        continue;
      }
      titles[sessionKey] = resolveSessionNavigationTitle(state, sessionKey, t);
    }
    return titles;
  }, [visibleBlockers, t]);
  const sessionTitles = useChatStore(useShallow(selectSessionTitles));

  const pendingBlockers = useMemo(() => visibleBlockers.map((card) => (
    card.source === 'chat_approval' && card.sessionKey
      ? { ...card, teamName: sessionTitles[card.sessionKey] || card.sessionKey }
      : card
  )), [sessionTitles, visibleBlockers]);

  if (pendingBlockers.length === 0) {
    return null;
  }

  const triggerLabel = `${t('sidebar.pendingBlockers')} (${pendingBlockers.length})`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={triggerLabel}
          aria-label={triggerLabel}
          className="relative mx-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] text-[hsl(var(--shell-icon))] transition-[background-color,color] hover:bg-[hsl(var(--shell-surface-hover))] hover:text-[hsl(var(--shell-icon-active))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--shell-surface))] data-[state=open]:bg-[hsl(var(--shell-surface-active))] data-[state=open]:text-[hsl(var(--shell-icon-active))]"
        >
          <ShieldCheck aria-hidden="true" className="h-[18px] w-[18px]" />
          <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[hsl(var(--shell-icon-active))] px-0.5 text-[9px] font-semibold leading-none text-[hsl(var(--shell-window))]">
            {pendingBlockers.length}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" className="w-80 max-w-[calc(100vw-24px)]" aria-label={t('sidebar.pendingBlockers')}>
        <DropdownMenuLabel className="flex items-center justify-between text-[11px] text-[hsl(var(--shell-text-muted))]">
          <span>{t('sidebar.pendingBlockers')}</span>
          <span>{pendingBlockers.length}</span>
        </DropdownMenuLabel>
        <div className="max-h-56 space-y-1 overflow-y-auto pr-0.5">
          {pendingBlockers.map((card) => (
            <DropdownMenuItem
              key={card.id}
              className="flex-col items-stretch gap-0 rounded-[12px] text-left data-[highlighted]:bg-[hsl(var(--shell-surface-hover))] data-[highlighted]:text-[hsl(var(--shell-icon-active))]"
              onSelect={() => {
                if (card.source === 'team_approval') {
                  setActiveTeam(card.teamId);
                  navigate(`/teams/${card.teamId}`);
                  return;
                }
                if (card.source === 'chat_approval' && card.sessionKey) {
                  navigate(`/?session=${encodeURIComponent(card.sessionKey)}`);
                  return;
                }
                navigate('/tasks');
              }}
            >
              <div className="flex items-center gap-2 text-xs font-medium text-[hsl(var(--shell-icon-active))]">
                <span className="min-w-0 flex-1 truncate">{card.title}</span>
                <span className="shrink-0 text-[11px] font-normal text-[hsl(var(--shell-text-muted))]">{formatMessageTime(card.createdAt)}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[hsl(var(--shell-text-muted))]">
                <span className="min-w-0 flex-1 truncate">
                  {card.source === 'team_approval'
                    ? card.teamName
                    : t('sidebar.pendingBlockerSourceChat')}
                </span>
                <span className="shrink-0">
                  {card.source === 'team_approval'
                    ? t('sidebar.pendingBlockerFrom', { from: card.from })
                    : t('sidebar.pendingBlockerApprovalId', { id: card.from })}
                </span>
              </div>
              <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-[hsl(var(--shell-text-muted))]">
                {card.content}
              </div>
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

export default SidebarPendingBlockers;
