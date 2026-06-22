import type { TeamMail } from './domain/team-mail';
import type { TeamMailDeliveryInput, TeamMailDeliveryPort, TeamMailDeliveryResult } from './ports/team-mail-delivery-port';
import type { TeamRoleSessionPort } from './ports/team-role-session-port';

export class TeamRuntimeMailDeliveryService implements TeamMailDeliveryPort {
  constructor(private readonly deps: {
    readonly roleSessions: Pick<TeamRoleSessionPort, 'promptRoleSession'>;
    readonly nowMs: () => number;
  }) {}

  async deliver(input: TeamMailDeliveryInput): Promise<TeamMailDeliveryResult> {
    await this.deps.roleSessions.promptRoleSession({
      binding: input.binding,
      message: formatTeamMailPrompt(input.mail),
      idempotencyKey: input.idempotencyKey,
    });
    return {
      mailId: input.mail.mailId,
      status: 'delivered',
      deliveredAt: this.deps.nowMs(),
    };
  }
}

function formatTeamMailPrompt(mail: TeamMail): string {
  return [
    `Team mail: ${mail.subject}`,
    `Kind: ${mail.kind}`,
    `Thread: ${mail.threadId}`,
    '',
    mail.body ?? '',
    mail.bodyRef ? `Body reference: ${mail.bodyRef}` : '',
    mail.payloadRef ? `Payload reference: ${mail.payloadRef}` : '',
  ].filter(Boolean).join('\n');
}
