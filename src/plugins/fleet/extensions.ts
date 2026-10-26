import type { ComponentType } from 'react';
import { defineExtensionPoint } from '@/plugin-host/core';
import type { FleetRegistrationFormState } from './registration/form';
import type { RemoteFleetConnectionSummary, RemoteFleetEnvironmentRegistration, RemoteFleetNodeTargetKind } from './store';

export type FleetCredentialName = 'sshPassword' | 'sshPrivateKey' | 'dockerBearerToken' | 'kubeBearerToken';

export interface FleetCredentialDraft {
  readonly credentialName: FleetCredentialName;
  readonly plaintextValue: string;
}

export interface FleetRegistrationFieldsProps {
  readonly form: FleetRegistrationFormState;
  readonly editing: boolean;
  readonly setForm: (updater: (current: FleetRegistrationFormState) => FleetRegistrationFormState) => void;
  readonly clearCredentialOperationIds: () => void;
}

export interface FleetRegistrationTarget {
  readonly kind: RemoteFleetNodeTargetKind;
  readonly publicConfigPlaceholderKey: string;
  readonly secretRefsPlaceholderKey: string;
  readonly fields: ComponentType<FleetRegistrationFieldsProps>;
  readonly fromConnection: (connection: RemoteFleetConnectionSummary) => Partial<FleetRegistrationFormState>;
  readonly connection: (form: FleetRegistrationFormState) => {
    readonly endpointUrl?: string;
    readonly displayNameSeed: string;
    readonly publicConfig: Record<string, unknown>;
  };
  readonly environment: (form: FleetRegistrationFormState) => {
    readonly environmentKind: RemoteFleetEnvironmentRegistration['environmentKind'];
    readonly displayNameSeed: string;
    readonly publicConfig: Record<string, unknown>;
  };
  readonly credentialDrafts: (form: FleetRegistrationFormState) => readonly FleetCredentialDraft[];
  readonly submitSeed: (form: FleetRegistrationFormState) => string;
  readonly confirmDeployment: boolean;
}

// Renderer registration fields and conversion only; provider operations and authorization remain Host-owned.
export const fleetRegistrationTargets = defineExtensionPoint<FleetRegistrationTarget>('fleet.registration.targets');
