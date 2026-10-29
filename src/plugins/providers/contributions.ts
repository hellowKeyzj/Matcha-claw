import { contribute, lazyWithPreload } from '@/plugin-host/core';
import { PROVIDER_TYPE_INFO } from '@/plugins/providers/domain/providers';
import {
  providerAuthMethods,
  providerForms,
  providerModelSources,
  providerVendors,
  type ProviderAuthContribution,
  type ProviderFormContribution,
} from './extensions';

const conflicts = [
  { vendors: ['minimax-portal', 'minimax-portal-cn'], message: 'aiProviders.toast.minimaxConflict' },
  { vendors: ['zai', 'zai-global'], message: 'aiProviders.toast.zaiConflict' },
];

const OAuthPanel = lazyWithPreload(async () => ({ default: (await import('./auth/ProviderOAuthInteraction')).OAuthPanel }));
const ProviderAccountAddForm = lazyWithPreload(async () => ({ default: (await import('./forms/ProviderAccountForm')).ProviderAccountAddForm }));
const StandardProviderEditForm = lazyWithPreload(async () => ({ default: (await import('./forms/ProviderAccountForm')).StandardProviderEditForm }));
const LocalProviderEditForm = lazyWithPreload(async () => ({ default: (await import('./forms/ProviderAccountForm')).LocalProviderEditForm }));
const CustomProviderEditForm = lazyWithPreload(async () => ({ default: (await import('./forms/ProviderAccountForm')).CustomProviderEditForm }));

const authMethods: ProviderAuthContribution[] = [
  {
    id: 'credential',
    flow: 'credential',
    methods: [
      { id: 'api_key', label: 'aiProviders.authModes.apiKey', input: 'apiKey' },
      { id: 'token', label: 'aiProviders.authModes.token', input: 'token' },
      { id: 'local', label: 'aiProviders.authModes.local', input: null },
    ],
  },
  {
    id: 'oauth',
    flow: 'oauth',
    component: OAuthPanel,
    methods: [
      { id: 'oauth_device', label: 'aiProviders.authModes.oauthDevice', input: null },
      { id: 'oauth_browser', label: 'aiProviders.authModes.oauthBrowser', input: null },
    ],
  },
  {
    id: 'cli-reuse',
    flow: 'cli-reuse',
    methods: [{ id: 'cli_reuse', label: 'aiProviders.authModes.cliReuse', input: null }],
  },
];

const forms: ProviderFormContribution[] = [
  { id: 'standard', add: ProviderAccountAddForm, edit: StandardProviderEditForm },
  { id: 'local', add: ProviderAccountAddForm, edit: LocalProviderEditForm },
  { id: 'custom', add: ProviderAccountAddForm, edit: CustomProviderEditForm },
];

export const providerContributions = [
  ...PROVIDER_TYPE_INFO.map((info) => contribute(providerVendors, {
    info,
    form: info.id === 'custom' ? 'custom' : info.id === 'ollama' ? 'local' : 'standard',
    conflict: conflicts.find((conflict) => conflict.vendors.includes(info.id)),
  })),
  ...authMethods.map((method) => contribute(providerAuthMethods, method)),
  ...forms.map((form) => contribute(providerForms, form)),
  contribute(providerModelSources, {
    id: 'host-discovery',
    kind: 'discovery',
    label: 'providerModels.actions.discover',
    async discover(accountId, signal) {
      const { discoverProviderModels } = await import('@/plugins/providers/services/provider-model-catalog');
      return (await discoverProviderModels(accountId, signal)).models;
    },
  }),
  contribute(providerModelSources, {
    id: 'code-plan',
    kind: 'quick-add',
    label: 'providerModels.codePlan.add',
    addedLabel: 'providerModels.codePlan.added',
    model: (vendor) => vendor?.codePlan?.modelId
      ? { modelId: vendor.codePlan.modelId, capabilities: ['chat'] }
      : undefined,
  }),
];
