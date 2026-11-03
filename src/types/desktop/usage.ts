export type UsageHistoryEntry = Readonly<{
  timestamp: string;
  sessionId: string;
  agentId: string;
  model?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd?: number;
}>;

export type UsageUnknownReason =
  | 'native_result_session_mismatch'
  | 'native_result_identity_missing'
  | 'native_execution_error_placeholder'
  | 'native_usage_scope_unknown'
  | 'native_usage_missing_or_invalid';

export type UsageUnknownEntry = Readonly<{
  sessionId: string;
  agentId: string;
  timestamp: string;
  reason: UsageUnknownReason;
}>;

export type UsageCoverage =
  | Readonly<{ kind: 'reported' }>
  | Readonly<{
    kind: 'observed';
    hasMore: boolean;
    nativeOutcomeUnknown: boolean;
    unknownEntries: readonly UsageUnknownEntry[];
  }>;

export type UsageHistory = Readonly<{
  entries: readonly UsageHistoryEntry[];
  coverage: UsageCoverage;
}>;
