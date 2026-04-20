export type ChannelActivationMode = 'direct-config' | 'login-session';

const LOGIN_SESSION_CHANNEL_TYPES = new Set([
  'whatsapp',
  'openclaw-weixin',
]);

export function resolveChannelActivationMode(channelType: string): ChannelActivationMode {
  return LOGIN_SESSION_CHANNEL_TYPES.has(channelType)
    ? 'login-session'
    : 'direct-config';
}

export function channelUsesLoginSession(channelType: string): boolean {
  return resolveChannelActivationMode(channelType) === 'login-session';
}
