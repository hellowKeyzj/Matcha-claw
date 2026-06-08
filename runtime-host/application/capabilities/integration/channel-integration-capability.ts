import type { ChannelService } from '../../channels/service';
import { badRequest } from '../../common/application-response';
import type { ChannelPairingTarget, ChannelTarget } from '../../agent-runtime/contracts/runtime-address';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute, CapabilityOperationContext } from '../contracts/capability-router';

export const CHANNEL_INTEGRATION_CAPABILITY_ID = 'integration.channel';

export const channelIntegrationCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'channels.probe', title: 'Probe channel integrations', targetKind: 'none' },
  { id: 'channels.activate', title: 'Activate channel integration', targetKind: 'channel' },
  { id: 'channels.cancelSession', title: 'Cancel channel login session', targetKind: 'channel-pairing' },
  { id: 'channels.connect', title: 'Connect channel integration', targetKind: 'channel' },
  { id: 'channels.disconnect', title: 'Disconnect channel integration', targetKind: 'channel' },
  { id: 'channels.requestQr', title: 'Request channel QR code', targetKind: 'channel-pairing' },
  { id: 'channels.approvePairing', title: 'Approve channel pairing request', targetKind: 'channel-pairing' },
  { id: 'channels.deleteConfig', title: 'Delete channel configuration', targetKind: 'channel' },
] as const;

export function createChannelIntegrationCapabilityOperationRoutes(deps: {
  channelService: Pick<ChannelService,
    | 'probe'
    | 'activate'
    | 'cancelSession'
    | 'connect'
    | 'disconnect'
    | 'requestQr'
    | 'approvePairingRequest'
    | 'deleteConfig'
  >;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: CHANNEL_INTEGRATION_CAPABILITY_ID,
      operationId: 'channels.probe',
      handle: () => deps.channelService.probe(),
    },
    {
      capabilityId: CHANNEL_INTEGRATION_CAPABILITY_ID,
      operationId: 'channels.activate',
      handle: (context) => {
        const targetError = validateChannelTargetInput(context);
        if (targetError) {
          return badRequest(targetError);
        }
        return deps.channelService.activate(channelInputFromTarget(context.target as ChannelTarget, context.domainInput));
      },
    },
    {
      capabilityId: CHANNEL_INTEGRATION_CAPABILITY_ID,
      operationId: 'channels.cancelSession',
      handle: (context) => {
        const targetError = validateChannelPairingTargetInput(context);
        if (targetError) {
          return badRequest(targetError);
        }
        return deps.channelService.cancelSession(channelInputFromTarget(context.target as ChannelPairingTarget, context.domainInput));
      },
    },
    {
      capabilityId: CHANNEL_INTEGRATION_CAPABILITY_ID,
      operationId: 'channels.connect',
      handle: (context) => {
        const targetError = validateChannelTargetInput(context);
        if (targetError) {
          return badRequest(targetError);
        }
        return deps.channelService.connect(channelInputFromTarget(context.target as ChannelTarget, context.domainInput));
      },
    },
    {
      capabilityId: CHANNEL_INTEGRATION_CAPABILITY_ID,
      operationId: 'channels.disconnect',
      handle: (context) => {
        const targetError = validateChannelTargetInput(context);
        if (targetError) {
          return badRequest(targetError);
        }
        return deps.channelService.disconnect(channelInputFromTarget(context.target as ChannelTarget, context.domainInput));
      },
    },
    {
      capabilityId: CHANNEL_INTEGRATION_CAPABILITY_ID,
      operationId: 'channels.requestQr',
      handle: (context) => {
        const targetError = validateChannelPairingTargetInput(context);
        if (targetError) {
          return badRequest(targetError);
        }
        return deps.channelService.requestQr(channelInputFromTarget(context.target as ChannelPairingTarget, context.domainInput));
      },
    },
    {
      capabilityId: CHANNEL_INTEGRATION_CAPABILITY_ID,
      operationId: 'channels.approvePairing',
      handle: (context) => {
        const targetError = validateChannelPairingTargetInput(context);
        if (targetError) {
          return badRequest(targetError);
        }
        const target = context.target as ChannelPairingTarget;
        const body = channelInputFromTarget(target, context.domainInput);
        return deps.channelService.approvePairingRequest(target.channelType, body);
      },
    },
    {
      capabilityId: CHANNEL_INTEGRATION_CAPABILITY_ID,
      operationId: 'channels.deleteConfig',
      handle: (context) => {
        const targetError = validateChannelTargetInput(context);
        if (targetError) {
          return badRequest(targetError);
        }
        return deps.channelService.deleteConfig((context.target as ChannelTarget).channelType);
      },
    },
  ];
}

function validateChannelTargetInput(context: CapabilityOperationContext): string | null {
  if (context.target?.kind !== 'channel') {
    return 'Capability target kind must be channel';
  }
  return validateChannelFields(context.target, context.domainInput, ['channelType', 'accountId']);
}

function validateChannelPairingTargetInput(context: CapabilityOperationContext): string | null {
  if (context.target?.kind !== 'channel-pairing') {
    return 'Capability target kind must be channel-pairing';
  }
  return validateChannelFields(context.target, context.domainInput, ['channelType', 'accountId', 'pairingId']);
}

function validateChannelFields(
  target: ChannelTarget | ChannelPairingTarget,
  input: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    const targetValue = field === 'pairingId' ? readString((target as ChannelPairingTarget).pairingId) : readString(target[field as keyof ChannelTarget]);
    const inputKey = field === 'pairingId' ? 'code' : field;
    const inputValue = readString(input[inputKey]);
    if (targetValue !== inputValue) {
      return field === 'pairingId'
        ? 'Capability target pairingId must match input code'
        : `Capability target ${field} must match input ${field}`;
    }
  }
  return null;
}

function channelInputFromTarget(
  target: ChannelTarget | ChannelPairingTarget,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...input,
    channelType: target.channelType,
    ...(target.accountId ? { accountId: target.accountId } : {}),
    ...(target.kind === 'channel-pairing' && target.pairingId ? { code: target.pairingId } : {}),
  };
}

function readString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

