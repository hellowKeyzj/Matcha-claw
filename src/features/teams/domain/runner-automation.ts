import type { TeamTask } from '@/features/teams/api/runtime-client';

export type BlockedDecisionAction = 'retry' | 'fail' | null;

const RETRY_KEYWORDS = [
  'retry',
  'resume',
  'continue',
  'rerun',
  '重试',
  '恢复',
  '继续',
  '再试',
];

const FAIL_KEYWORDS = [
  'fail',
  'cancel',
  'abort',
  'close',
  'stop',
  'failed',
  '放弃',
  '终止',
  '取消',
  '失败',
  '关闭',
];

function includesAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

export function parseBlockedDecision(content: string): BlockedDecisionAction {
  const normalized = String(content ?? '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  try {
    const json = JSON.parse(normalized) as { decision?: unknown };
    if (typeof json?.decision === 'string') {
      const decision = json.decision.trim().toLowerCase();
      if (decision === 'retry' || decision === 'resume' || decision === 'continue') {
        return 'retry';
      }
      if (decision === 'fail' || decision === 'cancel' || decision === 'abort') {
        return 'fail';
      }
    }
  } catch {
    // 普通文本决策无需 JSON。
  }

  if (includesAnyKeyword(normalized, RETRY_KEYWORDS)) {
    return 'retry';
  }
  if (includesAnyKeyword(normalized, FAIL_KEYWORDS)) {
    return 'fail';
  }
  return null;
}

export function deriveAutoBlockedDecision(task: Pick<TeamTask, 'attempt' | 'error'>): {
  action: Exclude<BlockedDecisionAction, null>;
  reason: string;
} {
  if ((task.attempt ?? 0) < 2) {
    return {
      action: 'retry',
      reason: '自动仲裁：当前重试次数较低，先执行一次重试。',
    };
  }
  return {
    action: 'fail',
    reason: `自动仲裁：任务已重试 ${(task.attempt ?? 0)} 次，建议标记失败并等待人工处理。`,
  };
}

export function deriveTaskTitleFromProposal(content: string): string {
  const text = String(content ?? '').trim();
  if (!text) {
    return '自动规划任务';
  }
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!firstLine) {
    return '自动规划任务';
  }
  if (firstLine.length <= 32) {
    return firstLine;
  }
  return `${firstLine.slice(0, 32)}...`;
}

