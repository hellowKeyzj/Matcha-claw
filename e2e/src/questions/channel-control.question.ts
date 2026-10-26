import { notes } from '@serenity-js/core';

type ChannelControlNotes = {
  channelControlConnected: boolean;
  channelControlBaselineRestored: boolean;
  channelControlSettlement: {
    admitted: boolean; status: string; operation: string; phase: string; outcome: string; sameAccount: boolean; redacted: boolean;
  };
};

export const SandboxConnectionWasObserved = () => notes<ChannelControlNotes>().get('channelControlConnected');
export const SandboxBaselineWasRestored = () => notes<ChannelControlNotes>().get('channelControlBaselineRestored');
export const SandboxDisconnectSettlement = () => notes<ChannelControlNotes>().get('channelControlSettlement');
