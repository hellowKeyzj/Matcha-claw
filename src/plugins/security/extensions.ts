import type { ComponentType } from 'react';
import { defineExtensionPoint } from '@/plugin-host/core';

export interface SecuritySectionProps {
  policyControlsDisabled: boolean;
  gatewayOperational: boolean;
  gatewayPreparing: boolean;
  gatewayProcessState: string;
}

export interface SecuritySectionContribution {
  id: string;
  label: string;
  order: number;
  component: ComponentType<SecuritySectionProps>;
}

export interface SecurityCheckProps {
  disabled: boolean;
  runSecurityOp: <T>(
    name: string,
    runner: () => Promise<T>,
    consumeResult?: (result: T) => { display: string; success: boolean; message?: string },
  ) => Promise<void>;
}

export interface SecurityCheckContribution {
  id: string;
  order: number;
  component: ComponentType<SecurityCheckProps>;
}

// These contributions assemble UI only; Host/native policy and authorization remain authoritative.
export const securitySections = defineExtensionPoint<SecuritySectionContribution>('security.sections');
export const securityChecks = defineExtensionPoint<SecurityCheckContribution>('security.checks');
