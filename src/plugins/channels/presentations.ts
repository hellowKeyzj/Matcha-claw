import { lazy } from 'react';
import { CHANNEL_META, CONFIGURABLE_CHANNEL_TYPES } from '@/types/channel';
import type { ChannelType } from '@/types/channel';
import type { ChannelPresentation, OpenClawLoginFlow } from './extensions';

const OpenClawConfiguration = lazy(() => import('./OpenClawConfiguration'));
const OpenClawPairing = lazy(() => import('./OpenClawPairing'));
const MatchaWeixinConfiguration = lazy(() => import('./MatchaWeixinConfiguration'));

const openClawLoginFlows: Partial<Record<ChannelType, OpenClawLoginFlow>> = {
  whatsapp: { kind: 'qr-login', channel: 'whatsapp' },
  'openclaw-weixin': { kind: 'qr-login', channel: 'openclaw-weixin' },
  qqbot: { kind: 'authorization', channel: 'qqbot' },
  dingtalk: { kind: 'authorization', channel: 'dingtalk' },
  feishu: { kind: 'authorization', channel: 'feishu' },
};

const openClawCatalog: ChannelType[] = [
  ...CONFIGURABLE_CHANNEL_TYPES,
  ...Object.values(CHANNEL_META)
    .filter((meta) => meta.id !== 'weixin' && !CONFIGURABLE_CHANNEL_TYPES.some((id) => id === meta.id))
    .map((meta) => meta.id),
];

export const builtinChannelPresentations: readonly ChannelPresentation[] = [
  ...openClawCatalog.map((type): ChannelPresentation => ({
    runtimeAdapterId: 'openclaw',
    meta: CHANNEL_META[type],
    availableToAdd: CONFIGURABLE_CHANNEL_TYPES.some((id) => id === type),
    configuration: OpenClawConfiguration,
    login: openClawLoginFlows[type],
    ...(type === 'feishu' ? { pairing: OpenClawPairing } : {}),
    ...(type === 'openclaw-weixin'
      ? { advancedFieldKeys: ['baseUrl', 'cdnBaseUrl', 'logUploadUrl', 'routeTag'] }
      : {}),
  })),
  {
    runtimeAdapterId: 'matcha-agent',
    meta: CHANNEL_META.weixin,
    availableToAdd: true,
    configuration: MatchaWeixinConfiguration,
  },
];
