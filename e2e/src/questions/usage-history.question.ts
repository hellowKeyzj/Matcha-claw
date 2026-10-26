import { Question, notes } from '@serenity-js/core';
import { Attribute, Text } from '@serenity-js/web';
import { UsageHistoryPage } from '../pages/usage-history.page.js';

type UsageEntry = {
  timestamp: string; sessionId: string; agentId: string; model?: string; provider?: string;
  totalTokens: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
};

export const DashboardUsageHasNoErrors = () => UsageHistoryPage.errors.count().as(count => count === 0);

export const DashboardUsageHasSettled = () => Question.about('Dashboard has rendered history or an explicit terminal feedback state', async actor =>
  await actor.answer(UsageHistoryPage.loading.count()) === 0
  && (await actor.answer(UsageHistoryPage.empty.isVisible())
    || await actor.answer(UsageHistoryPage.emptyWindow.isVisible())
    || await actor.answer(UsageHistoryPage.records.isVisible())
    || await actor.answer(UsageHistoryPage.errors.count()) > 0),
);

export const DashboardUsageMatchesPublicProjection = () => Question.about('Dashboard history matches the selected runtime public usage DTO, without hiding errors', async actor => {
  const entries = await actor.answer(notes<{ usageHistoryProjection: UsageEntry[] }>().get('usageHistoryProjection'));
  if (!await actor.answer(UsageHistoryPage.heading.isVisible())
    || await actor.answer(UsageHistoryPage.errors.count()) !== 0
    || await actor.answer(UsageHistoryPage.loading.count()) !== 0) return false;
  const rows = await actor.answer(Text.ofAll(UsageHistoryPage.rows));
  const hasRecordCount = await actor.answer(UsageHistoryPage.records.isPresent());
  const isEmpty = await actor.answer(UsageHistoryPage.empty.isVisible());
  const isEmptyWindow = await actor.answer(UsageHistoryPage.emptyWindow.isVisible());
  if (entries.length === 0) return isEmpty && !isEmptyWindow && rows.length === 0 && !hasRecordCount;
  const now = Date.now();
  // OpenDashboardUsage reloads the renderer, establishing the current non-persisted 7d default even when controls are hidden.
  if (isEmptyWindow) {
    return !entries.some(entry => Date.parse(entry.timestamp) >= now - 7 * 86_400_000)
      && !isEmpty && rows.length === 0 && !hasRecordCount;
  }
  if (isEmpty || !hasRecordCount) return false;
  const selectedWindows = [];
  for (const [element, days] of [[UsageHistoryPage.sevenDays, 7], [UsageHistoryPage.thirtyDays, 30], [UsageHistoryPage.allTime, 0]] as const) {
    const classes = await actor.answer(Attribute.called('class').of(element));
    if (classes?.split(/\s+/).includes('text-secondary-foreground')) selectedWindows.push(days);
  }
  if (selectedWindows.length !== 1) return false;
  const days = selectedWindows[0]!;
  const filtered = entries.filter(entry => days === 0 || Date.parse(entry.timestamp) >= now - days * 86_400_000);
  const recordCount = await actor.answer(Text.of(UsageHistoryPage.records));
  const pagination = await actor.answer(Text.of(UsageHistoryPage.pagination));
  const page = /^(?:第 |Page )(\d+) \/ (\d+)(?: 页)?$/.exec(pagination);
  if (!page || Number(recordCount.replace(/\D/g, '')) !== filtered.length
    || Number(page[2]) !== Math.max(1, Math.ceil(filtered.length / 5))) return false;
  const currentPage = Number(page[1]);
  if (currentPage < 1 || currentPage > Number(page[2])) return false;
  const visibleEntries = filtered.slice((currentPage - 1) * 5, currentPage * 5);
  if (rows.length !== visibleEntries.length) return false;
  const visibleRows = rows.values();
  for (const entry of visibleEntries) {
    const { value: row } = visibleRows.next();
    if (!row || !row.includes(entry.sessionId) || !row.includes(entry.agentId)
      || (entry.model && !row.includes(entry.model)) || (entry.provider && !row.includes(entry.provider))) return false;
  }
  const totals = filtered.reduce((sum, entry) => ({
    total: sum.total + entry.totalTokens,
    input: sum.input + entry.inputTokens,
    output: sum.output + entry.outputTokens,
    cache: sum.cache + entry.cacheReadTokens + entry.cacheWriteTokens,
  }), { total: 0, input: 0, output: 0, cache: 0 });
  const summaries = [
    [UsageHistoryPage.totalTokens, totals.total], [UsageHistoryPage.inputTokens, totals.input],
    [UsageHistoryPage.outputTokens, totals.output], [UsageHistoryPage.cacheTokens, totals.cache],
  ] as const;
  for (const [element, expected] of summaries) {
    if (Number((await actor.answer(Text.of(element))).replace(/\D/g, '')) !== expected) return false;
  }
  return true;
});
