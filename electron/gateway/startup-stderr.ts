export type GatewayStderrClassification = {
  level: 'drop' | 'debug' | 'warn';
  normalized: string;
};

const MAX_STDERR_LINES = 120;

export function classifyGatewayStderrMessage(message: string): GatewayStderrClassification {
  const msg = message.trim();
  if (!msg) {
    return { level: 'drop', normalized: msg };
  }

  // Known noisy lines that are not actionable for Gateway lifecycle debugging.
  if (msg.includes('openclaw-control-ui') && msg.includes('token_mismatch')) {
    return { level: 'drop', normalized: msg };
  }
  if (msg.includes('closed before connect') && msg.includes('token mismatch')) {
    return { level: 'drop', normalized: msg };
  }

  // Downgrade frequent non-fatal noise.
  if (msg.includes('ExperimentalWarning')) return { level: 'debug', normalized: msg };
  if (msg.includes('DeprecationWarning')) return { level: 'debug', normalized: msg };
  if (msg.includes('Debugger attached')) return { level: 'debug', normalized: msg };
  if (msg.includes('Config warnings:')) return { level: 'debug', normalized: msg };

  // Electron restricts NODE_OPTIONS in packaged apps; this is expected and harmless.
  if (msg.includes('node: --require is not allowed in NODE_OPTIONS')) {
    return { level: 'debug', normalized: msg };
  }
  // OpenClaw 在扫描 skills 时会对越界路径给出保护性告警。
  // 该告警不影响 Gateway 生命周期，且在页面高频查询技能状态时会反复出现。
  if (msg.includes('Skipping skill path that resolves outside its configured root')) {
    return { level: 'debug', normalized: msg };
  }

  return { level: 'warn', normalized: msg };
}

export function shouldSuppressGatewayStderrRepeat(
  dedupCounter: Map<string, number>,
  normalizedMessage: string,
  summaryEvery = 50,
): {
  suppress: boolean;
  repeatCount: number;
  emitSummary: boolean;
} {
  const repeatCount = (dedupCounter.get(normalizedMessage) ?? 0) + 1;
  dedupCounter.set(normalizedMessage, repeatCount);
  return {
    suppress: repeatCount > 1,
    repeatCount,
    emitSummary: repeatCount > 1 && repeatCount % Math.max(1, summaryEvery) === 0,
  };
}

export function recordGatewayStartupStderrLine(lines: string[], line: string): void {
  const normalized = line.trim();
  if (!normalized) return;
  lines.push(normalized);
  if (lines.length > MAX_STDERR_LINES) {
    lines.splice(0, lines.length - MAX_STDERR_LINES);
  }
}
