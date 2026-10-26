import type { ComponentType } from 'react';
import { defineExtensionPoint } from '@/plugin-host/core';
import type { AppConnectorManifest } from '@/types/desktop/app-plugin';
import type { ConnectorFormState, PrivateField } from './form';
import type { ExternalConnectorKind, ExternalConnectorPatch, ExternalConnectorSpec, ExternalConnectorSummary, ExternalMcpServerProgramDescriptor } from './store';

export interface ConnectorTransportFieldsProps {
  form: ConnectorFormState;
  editing: boolean;
  update: <K extends keyof ConnectorFormState>(key: K, value: ConnectorFormState[K]) => void;
  mcpServerPrograms: readonly ExternalMcpServerProgramDescriptor[];
  fieldHints?: AppConnectorManifest['fieldHints'];
}

export interface ConnectorFormContribution {
  id: string;
  sourceId?: string;
  platform?: AppConnectorManifest;
  kind: ExternalConnectorKind;
  privateFields: readonly PrivateField[];
  component: ComponentType<ConnectorTransportFieldsProps>;
  fromSummary: (connector: ExternalConnectorSummary) => ConnectorFormState;
  create: (form: ConnectorFormState, programs: readonly ExternalMcpServerProgramDescriptor[]) => ExternalConnectorSpec;
  patch: (form: ConnectorFormState, connector: ExternalConnectorSummary) => ExternalConnectorPatch;
}

export const connectorForms = defineExtensionPoint<ConnectorFormContribution>('connectors.forms');
