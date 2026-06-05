import { ok, type ApplicationResponse } from '../../common/application-response';
import type { ProviderAccountsService } from '../../providers/accounts';
import type { CapabilityRoutingApplicationService } from '../../providers/capability-routing-service';
import type { ProviderModelsApplicationService } from '../../providers/provider-models-service';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';

export const MODEL_PROVIDER_CAPABILITY_ID = 'model.provider';

export const modelProviderCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'providers.listAccounts', title: 'List provider accounts' },
  { id: 'providers.getAccount', title: 'Get provider account' },
  { id: 'providers.getApiKey', title: 'Get provider API key' },
  { id: 'providers.hasApiKey', title: 'Check provider API key' },
  { id: 'providers.validate', title: 'Validate provider credentials' },
  { id: 'providers.createAccount', title: 'Create provider account' },
  { id: 'providers.updateAccount', title: 'Update provider account' },
  { id: 'providers.deleteAccount', title: 'Delete provider account' },
  { id: 'providers.oauthStart', title: 'Start provider OAuth' },
  { id: 'providers.oauthCancel', title: 'Cancel provider OAuth' },
  { id: 'providers.oauthSubmit', title: 'Submit provider OAuth code' },
  { id: 'providers.oauthCompleteBrowser', title: 'Complete browser provider OAuth' },
  { id: 'providers.oauthCompleteDevice', title: 'Complete device provider OAuth' },
  { id: 'providerModels.list', title: 'List provider model catalog' },
  { id: 'providerModels.listSelectable', title: 'List selectable provider models' },
  { id: 'providerModels.get', title: 'Get provider model catalog' },
  { id: 'providerModels.replace', title: 'Replace provider model catalog' },
  { id: 'capabilityRouting.read', title: 'Read model capability routing' },
  { id: 'capabilityRouting.write', title: 'Write model capability routing' },
] as const;

export function createModelProviderCapabilityOperationRoutes(deps: {
  providerAccountsService: Pick<ProviderAccountsService,
    | 'list'
    | 'get'
    | 'getApiKey'
    | 'hasApiKey'
    | 'validate'
    | 'create'
    | 'update'
    | 'delete'
    | 'startOAuth'
    | 'cancelOAuth'
    | 'submitOAuth'
    | 'completeBrowser'
    | 'completeDevice'
  >;
  providerModelsService: Pick<ProviderModelsApplicationService, 'readAll' | 'readSelectable' | 'read' | 'replace'>;
  capabilityRoutingService: Pick<CapabilityRoutingApplicationService, 'read' | 'write'>;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.listAccounts',
      handle: async () => ok(await deps.providerAccountsService.list()),
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.getAccount',
      handle: async (context) => ok(await deps.providerAccountsService.get(readString(context.domainInput.accountId))),
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.getApiKey',
      handle: async (context) => ok(await deps.providerAccountsService.getApiKey(readString(context.domainInput.accountId))),
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.hasApiKey',
      handle: async (context) => ok(await deps.providerAccountsService.hasApiKey(readString(context.domainInput.accountId))),
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.validate',
      handle: async (context) => ok(await deps.providerAccountsService.validate(context.domainInput)),
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.createAccount',
      handle: (context) => deps.providerAccountsService.create(context.domainInput),
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.updateAccount',
      handle: (context) => {
        const body = context.domainInput;
        return deps.providerAccountsService.update(readString(body.accountId), body);
      },
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.deleteAccount',
      handle: (context) => {
        const body = context.domainInput;
        return deps.providerAccountsService.delete(readString(body.accountId), body.apiKeyOnly === true);
      },
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.oauthStart',
      handle: (context) => deps.providerAccountsService.startOAuth(context.domainInput),
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.oauthCancel',
      handle: () => deps.providerAccountsService.cancelOAuth(),
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.oauthSubmit',
      handle: (context) => deps.providerAccountsService.submitOAuth(context.domainInput),
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.oauthCompleteBrowser',
      handle: (context) => deps.providerAccountsService.completeBrowser(context.domainInput),
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.oauthCompleteDevice',
      handle: (context) => deps.providerAccountsService.completeDevice(context.domainInput),
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providerModels.list',
      handle: async () => ok(await deps.providerModelsService.readAll()),
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providerModels.listSelectable',
      handle: async () => ok(await deps.providerModelsService.readSelectable()),
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providerModels.get',
      handle: async (context) => ok(await deps.providerModelsService.read(readString(context.domainInput.credentialId))),
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providerModels.replace',
      handle: (context) => {
        const body = context.domainInput;
        return deps.providerModelsService.replace(readString(body.credentialId), body);
      },
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'capabilityRouting.read',
      handle: async () => ok(await deps.capabilityRoutingService.read()),
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'capabilityRouting.write',
      handle: (context) => deps.capabilityRoutingService.write(context.domainInput),
    },
  ];
}


function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
