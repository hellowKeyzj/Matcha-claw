import type { ComponentType, ReactNode } from 'react';
import { defineExtensionPoint } from '@/plugin-host/core';
import type { ProviderAuthMode, ProviderCredential, ProviderTypeInfo, ProviderVendorInfo, ProviderWithKeyInfo } from '@/plugins/providers/domain/providers';
import type { ProviderModelDraft } from '@/plugins/providers/services/provider-model-catalog';
import type { hostProviderStartOAuth } from '@/plugins/providers/services/provider-projection';

export interface ProviderVendorContribution {
  info: ProviderTypeInfo;
  form: string;
  oauthPanel?: ComponentType<ProviderOAuthPanelProps>;
  conflict?: { vendors: readonly string[]; message: string };
}

export interface ProviderAuthMethod {
  id: ProviderAuthMode;
  label: string;
  input: 'apiKey' | 'token' | 'optionalKey' | null;
}

export type ProviderOAuthStartRequest = Omit<Parameters<typeof hostProviderStartOAuth>[0], 'flowId'>;

export type ProviderOAuthOutcome = 'unconfirmed' | 'confirmed' | 'unknown';

export interface ProviderOAuthPanelProps {
  oauthFlowing: boolean;
  outcome: ProviderOAuthOutcome;
  oauthData: {
    mode: 'device';
    verificationUri: string;
    userCode: string;
    expiresIn: number;
  } | {
    mode: 'manual';
    authorizationUrl: string;
    message?: string;
  } | null;
  oauthError: string | null;
  manualCodeInput: string;
  pendingOAuth: { label: string } | null;
  onStart: () => void;
  onCancel: () => void;
  onManualCodeChange: (value: string) => void;
  onSubmitManualCode: () => void;
}

export interface ProviderOAuthInteraction {
  readonly flowing: boolean;
  readonly outcome: ProviderOAuthOutcome;
  renderPanel: (
    Panel: ComponentType<ProviderOAuthPanelProps>,
    createRequest: () => ProviderOAuthStartRequest | null,
  ) => ReactNode;
}

export interface ProviderOAuthOwnerProps {
  onCompleted: (account: ProviderCredential) => void;
  children: (interaction: ProviderOAuthInteraction) => ReactNode;
}

export type ProviderAuthContribution = {
  id: string;
  methods: readonly ProviderAuthMethod[];
} & (
  | { flow: 'credential' | 'cli-reuse' }
  | { flow: 'oauth'; component: ComponentType<ProviderOAuthPanelProps> }
);

export interface ProviderSecretInput {
  apiKey?: string;
  token?: string;
}

interface ProviderConfigurationProps {
  models: ProviderModelDraft[];
  modelsReady: boolean;
  modelsLoading: boolean;
  modelsError: string | null;
  onSubmit: (account: ProviderCredential, secret: ProviderSecretInput, creating: boolean) => Promise<ProviderCredential>;
  onReplaceModels: (accountId: string, models: ProviderModelDraft[]) => Promise<void>;
  onSaved: () => void;
  onBusyChange: (busy: boolean) => void;
  onAccountLocked: () => void;
}

export interface ProviderAddFormProps extends ProviderConfigurationProps {
  active: boolean;
  selection: 'brand' | 'variant';
  vendor: ProviderVendorContribution;
  accountVendor?: ProviderVendorInfo;
  existingVendorIds: ReadonlySet<string>;
  oauth: ProviderOAuthInteraction;
  completedAccount: ProviderCredential | null;
  onClose: () => void;
}

export interface ProviderEditFormProps extends ProviderConfigurationProps {
  active: boolean;
  account: ProviderCredential;
  vendor: ProviderVendorContribution;
  status?: Pick<ProviderWithKeyInfo, 'hasKey'>;
  accountVendor?: ProviderVendorInfo;
  onCancel: () => void;
}

export interface ProviderFormContribution {
  id: string;
  add: ComponentType<ProviderAddFormProps>;
  edit: ComponentType<ProviderEditFormProps>;
}

export type ProviderModelSourceContribution = {
  id: string;
  label: string;
  kind: 'discovery';
  discover: (account: ProviderCredential, secret: ProviderSecretInput) => Promise<ProviderModelDraft[]>;
} | {
  id: string;
  label: string;
  addedLabel: string;
  kind: 'quick-add';
  model: (vendor: ProviderVendorInfo | undefined) => ProviderModelDraft | undefined;
};

// These are Renderer configuration contributions, not native protocol or auth authority.
export const providerVendors = defineExtensionPoint<ProviderVendorContribution>('providers.vendors');
export const providerAuthMethods = defineExtensionPoint<ProviderAuthContribution>('providers.auth-methods');
export const providerForms = defineExtensionPoint<ProviderFormContribution>('providers.forms');
export const providerModelSources = defineExtensionPoint<ProviderModelSourceContribution>('providers.model-sources');
