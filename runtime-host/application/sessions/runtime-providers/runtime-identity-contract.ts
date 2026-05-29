export function buildFallbackRuntimeMessageId(input: {
  runtimeProviderId: string;
  sessionKey: string;
  runId?: string;
  turnId?: string;
  laneKey?: string;
  role: string;
  messageIndex: number;
}): string {
  return [
    input.runtimeProviderId,
    input.sessionKey,
    input.runId || input.turnId || 'turn',
    input.laneKey || 'main',
    input.role,
    String(input.messageIndex),
  ].join(':');
}
