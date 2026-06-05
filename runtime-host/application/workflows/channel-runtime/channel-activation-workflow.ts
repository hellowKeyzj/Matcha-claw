import {
  accepted,
  badRequest,
  ok,
  type ApplicationResponse,
} from '../../common/application-response';
import { DIRECT_CHANNEL_ACTIVATION_STRATEGY, channelUsesLoginSession, type ChannelActivationStrategyPort } from '../../channels/channel-activation-strategy';
import type { ChannelJobPort } from '../../channels/channel-jobs';
import type { ChannelLoginSessionService } from '../../channels/channel-login-session-service';
import type { ChannelConfigPort } from '../../channels/channel-runtime';

export interface ChannelActivationWorkflowDeps {
  readonly channelConfig: Pick<ChannelConfigPort, 'prepareChannelPlugin'>;
  readonly loginSessions: Pick<ChannelLoginSessionService, 'start' | 'cancel'>;
  readonly jobs: Pick<ChannelJobPort, 'submitActivateDirectChannel'>;
  readonly activationStrategy?: ChannelActivationStrategyPort;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class ChannelActivationWorkflow {
  constructor(private readonly deps: ChannelActivationWorkflowDeps) {}

  async activate(channelType: string, payload: unknown): Promise<ApplicationResponse> {
    if (!channelUsesLoginSession(this.activationStrategy, channelType)) {
      return accepted(this.deps.jobs.submitActivateDirectChannel(payload));
    }

    const body = isRecord(payload) ? payload : {};
    await this.deps.channelConfig.prepareChannelPlugin(channelType);
    const result = await this.deps.loginSessions.start({
      channelType,
      ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
      ...(isRecord(body.config) ? { config: body.config } : {}),
    });
    return ok({ success: true, ...result });
  }

  async cancelSession(channelType: string): Promise<ApplicationResponse> {
    if (!channelUsesLoginSession(this.activationStrategy, channelType)) {
      return badRequest(`channel ${channelType} does not use login session`);
    }

    await this.deps.loginSessions.cancel(channelType);
    return ok({ success: true });
  }

  private get activationStrategy(): ChannelActivationStrategyPort {
    return this.deps.activationStrategy ?? DIRECT_CHANNEL_ACTIVATION_STRATEGY;
  }
}
