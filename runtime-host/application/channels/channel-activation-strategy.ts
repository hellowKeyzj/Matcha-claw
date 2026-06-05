export type ChannelActivationMode = 'direct-config' | 'login-session';

export interface ChannelActivationStrategyPort {
  resolveChannelActivationMode(channelType: string): ChannelActivationMode;
}

export const DIRECT_CHANNEL_ACTIVATION_STRATEGY: ChannelActivationStrategyPort = {
  resolveChannelActivationMode: () => 'direct-config',
};

export function channelUsesLoginSession(
  strategy: ChannelActivationStrategyPort,
  channelType: string,
): boolean {
  return strategy.resolveChannelActivationMode(channelType) === 'login-session';
}
