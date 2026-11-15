import type { TeamMessageRecord } from '@/types/team-workspace';

export function mergeTeamMessageFragments(previous: TeamMessageRecord[], fragments: TeamMessageRecord[]): TeamMessageRecord[] {
  const messages = [...previous];
  const byMessageId = new Map(messages.map((message, index) => [message.messageId, index]));
  const encoder = new TextEncoder();
  for (const fragment of fragments) {
    const index = byMessageId.get(fragment.messageId);
    if (index === undefined) {
      if (fragment.bodyOffset !== 0) throw new Error('Team run message page is missing a prefix');
      byMessageId.set(fragment.messageId, messages.length);
      messages.push(fragment);
      continue;
    }
    const current = messages[index];
    if (current.runId !== fragment.runId || current.nodeId !== fragment.nodeId
      || current.nodeExecutionId !== fragment.nodeExecutionId || current.attemptId !== fragment.attemptId
      || current.bodyBytes !== fragment.bodyBytes || current.bodyOffset !== 0 || current.bodyComplete
      || encoder.encode(current.body).length !== fragment.bodyOffset) {
      throw new Error('Team run message fragments do not match');
    }
    messages[index] = { ...current, body: current.body + fragment.body, bodyComplete: fragment.bodyComplete };
  }
  return messages;
}
