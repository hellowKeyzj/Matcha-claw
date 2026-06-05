import type { ChannelService } from '../../channels/service';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';

export const CHANNEL_INTEGRATION_CAPABILITY_ID = 'integration.channel';

export const channelIntegrationCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'channels.probe', title: 'Probe channel integrations' },
  { id: 'channels.activate', title: 'Activate channel integration' },
  { id: 'channels.cancelSession', title: 'Cancel channel login session' },
  { id: 'channels.connect', title: 'Connect channel integration' },
  { id: 'channels.disconnect', title: 'Disconnect channel integration' },
  { id: 'channels.requestQr', title: 'Request channel QR code' },
  { id: 'channels.approvePairing', title: 'Approve channel pairing request' },
  { id: 'channels.deleteConfig', title: 'Delete channel configuration' },
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
      handle: (context) => deps.channelService.activate(context.domainInput),
    },
    {
      capabilityId: CHANNEL_INTEGRATION_CAPABILITY_ID,
      operationId: 'channels.cancelSession',
      handle: (context) => deps.channelService.cancelSession(context.domainInput),
    },
    {
      capabilityId: CHANNEL_INTEGRATION_CAPABILITY_ID,
      operationId: 'channels.connect',
      handle: (context) => deps.channelService.connect(context.domainInput),
    },
    {
      capabilityId: CHANNEL_INTEGRATION_CAPABILITY_ID,
      operationId: 'channels.disconnect',
      handle: (context) => deps.channelService.disconnect(context.domainInput),
    },
    {
      capabilityId: CHANNEL_INTEGRATION_CAPABILITY_ID,
      operationId: 'channels.requestQr',
      handle: (context) => deps.channelService.requestQr(context.domainInput),
    },
    {
      capabilityId: CHANNEL_INTEGRATION_CAPABILITY_ID,
      operationId: 'channels.approvePairing',
      handle: (context) => {
        const body = context.domainInput;
        const channelType = typeof body.channelType === 'string' ? body.channelType : '';
        return deps.channelService.approvePairingRequest(channelType, body);
      },
    },
    {
      capabilityId: CHANNEL_INTEGRATION_CAPABILITY_ID,
      operationId: 'channels.deleteConfig',
      handle: (context) => {
        const body = context.domainInput;
        const channelType = typeof body.channelType === 'string' ? body.channelType : '';
        return deps.channelService.deleteConfig(channelType);
      },
    },
  ];
}

