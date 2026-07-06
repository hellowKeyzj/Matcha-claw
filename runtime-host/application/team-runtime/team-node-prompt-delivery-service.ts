import type { TeamNodePromptDeliveryRecord } from './domain/team-node-prompt-delivery';
import type { TeamNodePromptDeliveryInput, TeamNodePromptDeliveryPort, TeamNodePromptDeliveryResult } from './ports/team-node-prompt-delivery-port';
import type { TeamRoleSessionPort } from './ports/team-role-session-port';

export class TeamRuntimeNodePromptDeliveryService implements TeamNodePromptDeliveryPort {
  constructor(private readonly deps: {
    readonly roleSessions: Pick<TeamRoleSessionPort, 'promptRoleSession'>;
    readonly nowMs: () => number;
  }) {}

  async deliver(input: TeamNodePromptDeliveryInput): Promise<TeamNodePromptDeliveryResult> {
    const prompt = await this.deps.roleSessions.promptRoleSession({
      binding: input.binding,
      message: formatTeamNodePrompt(input.delivery),
      displayMessage: input.delivery.displayMessage,
      idempotencyKey: input.idempotencyKey,
    });
    return {
      deliveryRecordId: input.delivery.deliveryRecordId,
      status: 'delivered',
      deliveredAt: this.deps.nowMs(),
      promptRunId: prompt.promptRunId,
    };
  }
}

function formatTeamNodePrompt(delivery: TeamNodePromptDeliveryRecord): string {
  return [
    '# TeamRun node prompt',
    '',
    '## Delivery envelope',
    '',
    'This envelope identifies the runtime delivery. Use the node-specific tool arguments in the prompt body below when calling TeamRun tools.',
    '',
    `- Title: ${delivery.title}`,
    `- Kind: ${delivery.kind}`,
    `- Node ID: ${delivery.nodeId}`,
    `- Node execution ID: ${delivery.nodeExecutionId}`,
    `- Role ID: ${delivery.roleId}`,
    '',
    delivery.prompt,
  ].filter(Boolean).join('\n');
}
