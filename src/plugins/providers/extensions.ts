import type { ComponentType, ReactNode } from 'react';
import { defineExtensionPoint } from '@/plugin-host/core';
import type { ProviderAuthMode, ProviderCredential, ProviderTypeInfo, ProviderVendorInfo, ProviderWithKeyInfo } from '@/lib/providers';
import type { ProviderModelDraft } from '@/lib/provider-model-catalog';
import type { hostProviderStartOAuth } from '@/lib/provider-projection';

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

export interface ProviderOAuthPanelProps {
  oauthFlowing: boolean;
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
  renderPanel: (
    Panel: ComponentType<ProviderOAuthPanelProps>,
    createRequest: () => ProviderOAuthStartRequest | null,
  ) => ReactNode;
}

export interface ProviderOAuthOwnerProps {
  onCompleted: () => void;
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

export type ProviderAccountDraft = Pick<ProviderCredential,
  'vendorId' | 'providerKind' | 'label' | 'authMode' | 'baseUrl' | 'apiProtocol' | 'mediaApiProtocol' | 'headers'
>;

export interface ProviderEditPayload {
  updates?: Partial<ProviderCredential>;
  newApiKey?: string;
  token?: string;
}

export interface ProviderAddFormProps {
  active: boolean;
  selection: 'brand' | 'variant';
  vendor: ProviderVendorContribution;
  accountVendor?: ProviderVendorInfo;
  existingVendorIds: ReadonlySet<string>;
  oauth: ProviderOAuthInteraction;
  onSubmit: (draft: ProviderAccountDraft, secret: ProviderSecretInput) => Promise<void>;
  onClose: () => void;
}

export interface ProviderEditFormProps {
  active: boolean;
  account: ProviderCredential;
  vendor: ProviderVendorContribution;
  status?: Pick<ProviderWithKeyInfo, 'hasKey'>;
  onSubmit: (payload: ProviderEditPayload) => Promise<void>;
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
  discover: (accountId: string, signal: AbortSignal) => Promise<ProviderModelDraft[]>;
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
