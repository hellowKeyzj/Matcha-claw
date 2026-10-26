import type { ComponentType } from 'react';
import { defineExtensionPoint } from '@/plugin-host/core';
import type { Channel, ChannelMeta, ChannelType } from '@/types/channel';
import type { RuntimeInstanceScope } from '@/types/desktop/runtime-address';

export type ChannelDialogTarget =
  | { kind: 'catalog' }
  | { kind: 'new'; type: ChannelType }
  | { kind: 'configured'; channel: Channel };

export interface ChannelConfigurationProps {
  scope: RuntimeInstanceScope;
  target: Exclude<ChannelDialogTarget, { kind: 'catalog' }>;
  presentation: ChannelPresentation;
  onBack: () => void;
  onClose: () => void;
  onChannelAdded: () => void;
}

export interface ChannelPairingProps {
  scope: RuntimeInstanceScope;
  channel: Channel;
  onClose: () => void;
}

export type OpenClawLoginFlow =
  | { kind: 'qr-login'; channel: Extract<ChannelType, 'whatsapp' | 'openclaw-weixin'> }
  | { kind: 'authorization'; channel: Extract<ChannelType, 'qqbot' | 'dingtalk' | 'feishu'> };

interface ChannelPresentationBase {
  meta: ChannelMeta;
  availableToAdd: boolean;
  configuration: ComponentType<ChannelConfigurationProps>;
  pairing?: ComponentType<ChannelPairingProps>;
}

export type ChannelPresentation = ChannelPresentationBase & (
  | { runtimeAdapterId: 'openclaw'; login?: OpenClawLoginFlow; advancedFieldKeys?: readonly string[] }
  | { runtimeAdapterId: 'matcha-agent'; login?: never; advancedFieldKeys?: never }
);

export const channelPresentations = defineExtensionPoint<ChannelPresentation>('channels.presentations');

export function channelConnectionLabelKey(connectionType: ChannelMeta['connectionType']): string {
  switch (connectionType) {
    case 'qr': return 'dialog.qrCode';
    case 'oauth': return 'dialog.authorization';
    case 'webhook': return 'dialog.webhook';
    case 'token': return 'dialog.token';
  }
}
