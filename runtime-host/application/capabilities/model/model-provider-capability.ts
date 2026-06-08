import { badRequest, ok, type ApplicationResponse } from '../../common/application-response';
import type { ProviderAccountsService } from '../../providers/accounts';
import type { CapabilityRoutingApplicationService } from '../../providers/capability-routing-service';
import type { ProviderModelsApplicationService } from '../../providers/provider-models-service';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';

export const MODEL_PROVIDER_CAPABILITY_ID = 'model.provider';

export const modelProviderCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'providers.listAccounts', title: 'List provider accounts', targetKind: 'none' },
  { id: 'providers.getAccount', title: 'Get provider account', targetKind: 'provider-account' },
  { id: 'providers.getApiKey', title: 'Get provider API key', targetKind: 'provider-credential' },
  { id: 'providers.hasApiKey', title: 'Check provider API key', targetKind: 'provider-credential' },
  { id: 'providers.validate', title: 'Validate provider credentials', targetKind: 'provider-credential' },
  { id: 'providers.createAccount', title: 'Create provider account', targetKind: 'provider-account' },
  { id: 'providers.updateAccount', title: 'Update provider account', targetKind: 'provider-account' },
  { id: 'providers.deleteAccount', title: 'Delete provider account', targetKind: 'provider-account' },
  { id: 'providers.oauthStart', title: 'Start provider OAuth', targetKind: 'provider-oauth' },
  { id: 'providers.oauthCancel', title: 'Cancel provider OAuth', targetKind: 'provider-oauth' },
  { id: 'providers.oauthSubmit', title: 'Submit provider OAuth code', targetKind: 'provider-oauth' },
  { id: 'providers.oauthCompleteBrowser', title: 'Complete browser provider OAuth', targetKind: 'provider-oauth' },
  { id: 'providers.oauthCompleteDevice', title: 'Complete device provider OAuth', targetKind: 'provider-oauth' },
  { id: 'providerModels.list', title: 'List provider model catalog', targetKind: 'none' },
  { id: 'providerModels.listSelectable', title: 'List selectable provider models', targetKind: 'none' },
  { id: 'providerModels.get', title: 'Get provider model catalog', targetKind: 'provider-credential' },
  { id: 'providerModels.replace', title: 'Replace provider model catalog', targetKind: 'provider-credential' },
  { id: 'capabilityRouting.read', title: 'Read model capability routing', targetKind: 'none' },
  { id: 'capabilityRouting.write', title: 'Write model capability routing', targetKind: 'capability-route' },
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
      handle: async (context) => {
        const accountId = readString(context.domainInput.accountId);
        const targetError = requireTargetBinding(context.target, 'provider-account', { accountId });
        return targetError ?? ok(await deps.providerAccountsService.get(accountId));
      },
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.getApiKey',
      handle: async (context) => {
        const accountId = readString(context.domainInput.accountId);
        const vendorId = readString(context.domainInput.vendorId);
        const targetError = requireTargetBinding(context.target, 'provider-credential', { accountId, vendorId });
        return targetError ?? ok(await deps.providerAccountsService.getApiKey(accountId));
      },
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.hasApiKey',
      handle: async (context) => {
        const accountId = readString(context.domainInput.accountId);
        const vendorId = readString(context.domainInput.vendorId);
        const targetError = requireTargetBinding(context.target, 'provider-credential', { accountId, vendorId });
        return targetError ?? ok(await deps.providerAccountsService.hasApiKey(accountId));
      },
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.validate',
      handle: async (context) => {
        const accountId = readString(context.domainInput.accountId);
        const vendorId = readString(context.domainInput.vendorId);
        const targetError = requireTargetBinding(context.target, 'provider-credential', {
          accountId: accountId || vendorId,
          vendorId,
        });
        return targetError ?? ok(await deps.providerAccountsService.validate(context.domainInput));
      },
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.createAccount',
      handle: (context) => {
        const account = readRecord(context.domainInput.account);
        const targetError = requireTargetBinding(context.target, 'provider-account', {
          accountId: readString(account?.id),
          vendorId: readString(account?.vendorId),
        });
        return targetError ?? deps.providerAccountsService.create(context.domainInput);
      },
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.updateAccount',
      handle: (context) => {
        const body = context.domainInput;
        const accountId = readString(body.accountId);
        const updates = readRecord(body.updates);
        const targetError = requireTargetBinding(context.target, 'provider-account', {
          accountId,
          ...(updates && Object.prototype.hasOwnProperty.call(updates, 'vendorId') ? { vendorId: readString(updates.vendorId) } : {}),
        });
        return targetError ?? deps.providerAccountsService.update(accountId, body);
      },
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.deleteAccount',
      handle: (context) => {
        const body = context.domainInput;
        const accountId = readString(body.accountId);
        const targetError = requireTargetBinding(context.target, 'provider-account', { accountId });
        return targetError ?? deps.providerAccountsService.delete(accountId, body.apiKeyOnly === true);
      },
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.oauthStart',
      handle: (context) => {
        const targetError = requireTargetBinding(context.target, 'provider-oauth', {
          flowId: readString(context.domainInput.flowId),
          accountId: readString(context.domainInput.accountId),
          vendorId: readString(context.domainInput.provider),
        });
        return targetError ?? deps.providerAccountsService.startOAuth(context.domainInput);
      },
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.oauthCancel',
      handle: (context) => {
        const targetError = requireTargetBinding(context.target, 'provider-oauth', {
          flowId: readString(context.domainInput.flowId),
          accountId: readString(context.domainInput.accountId),
          vendorId: readString(context.domainInput.vendorId),
        });
        return targetError ?? deps.providerAccountsService.cancelOAuth(context.domainInput);
      },
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.oauthSubmit',
      handle: (context) => {
        const targetError = requireTargetBinding(context.target, 'provider-oauth', {
          flowId: readString(context.domainInput.flowId),
          accountId: readString(context.domainInput.accountId),
          vendorId: readString(context.domainInput.vendorId),
        });
        return targetError ?? deps.providerAccountsService.submitOAuth(context.domainInput);
      },
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.oauthCompleteBrowser',
      handle: (context) => {
        const targetError = requireTargetBinding(context.target, 'provider-oauth', {
          flowId: readString(context.domainInput.flowId),
          accountId: readString(context.domainInput.accountId),
          vendorId: readString(context.domainInput.providerType),
        });
        return targetError ?? deps.providerAccountsService.completeBrowser(context.domainInput);
      },
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providers.oauthCompleteDevice',
      handle: (context) => {
        const targetError = requireTargetBinding(context.target, 'provider-oauth', {
          flowId: readString(context.domainInput.flowId),
          accountId: readString(context.domainInput.accountId),
          vendorId: readString(context.domainInput.providerType),
        });
        return targetError ?? deps.providerAccountsService.completeDevice(context.domainInput);
      },
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
      handle: async (context) => {
        const credentialId = readString(context.domainInput.credentialId);
        const vendorId = readString(context.domainInput.vendorId);
        const targetError = requireTargetBinding(context.target, 'provider-credential', { accountId: credentialId, vendorId });
        return targetError ?? ok(await deps.providerModelsService.read(credentialId));
      },
    },
    {
      capabilityId: MODEL_PROVIDER_CAPABILITY_ID,
      operationId: 'providerModels.replace',
      handle: (context) => {
        const body = context.domainInput;
        const credentialId = readString(body.credentialId);
        const vendorId = readString(body.vendorId);
        const targetError = requireTargetBinding(context.target, 'provider-credential', { accountId: credentialId, vendorId });
        return targetError ?? deps.providerModelsService.replace(credentialId, body);
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
      handle: (context) => {
        const targetError = requireTargetBinding(context.target, 'capability-route', { capabilityId: MODEL_PROVIDER_CAPABILITY_ID });
        return targetError ?? deps.capabilityRoutingService.write(context.domainInput);
      },
    },
  ];
}


function requireTargetBinding(
  target: { kind: string } | null,
  kind: 'provider-account' | 'provider-credential' | 'provider-oauth' | 'capability-route',
  bindings: Record<string, string | undefined>,
): ApplicationResponse | null {
  if (!target || target.kind !== kind) {
    return badRequest(`Capability target kind must be ${kind}`);
  }
  const targetRecord = target as Record<string, unknown>;
  for (const [field, inputValue] of Object.entries(bindings)) {
    if (inputValue === undefined) continue;
    if (!inputValue) {
      return badRequest(`Capability input ${field} is required`);
    }
    const targetValue = readString(targetRecord[field]);
    if (!targetValue) {
      return badRequest(`Capability target ${field} is required`);
    }
    if (targetValue !== inputValue) {
      return badRequest(`Capability target ${field} does not match input ${field}`);
    }
  }
  return null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
