import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ChevronDown, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  remoteFleetCommandOutcome,
  type RemoteFleetActionPayload,
  RemoteFleetConnectionRegistration,
  RemoteFleetConnectionSummary,
  RemoteFleetCredentialWriteInput,
  RemoteFleetCredentialWriteResult,
  RemoteFleetEnvironmentRegistration,
  RemoteFleetNodeTargetKind,
  RemoteFleetSecretRef,
} from '@/stores/remote-fleet';

type WritableCredentialName = 'sshPassword' | 'sshPrivateKey' | 'dockerBearerToken' | 'kubeBearerToken';
type SshAuthMethod = 'password' | 'private-key';
type ContainerAuthMethod = 'none' | 'bearer-token';
type VmAuthMethod = 'password' | 'private-key';

type NodeFormState = {
  id: string;
  displayName: string;
  targetKind: RemoteFleetNodeTargetKind;
  endpointUrl: string;
  containerName: string;
  containerImage: string;
  containerImageCandidates: string;
  sshHost: string;
  sshPort: string;
  sshUsername: string;
  sshAuthMethod: SshAuthMethod;
  sshPassword: string;
  sshPrivateKey: string;
  containerAuthMethod: ContainerAuthMethod;
  containerBearerToken: string;
  k8sApiServerUrl: string;
  k8sNamespace: string;
  k8sBearerToken: string;
  vmHost: string;
  vmPort: string;
  vmUsername: string;
  vmAuthMethod: VmAuthMethod;
  vmPassword: string;
  vmPrivateKey: string;
  labels: string;
  enabled: boolean;
  publicConfig: string;
  secretRefs: string;
};

const EMPTY_NODE_FORM: NodeFormState = {
  id: '',
  displayName: '',
  targetKind: 'ssh-host',
  endpointUrl: '',
  containerName: '',
  containerImage: '',
  containerImageCandidates: '',
  sshHost: '',
  sshPort: '',
  sshUsername: '',
  sshAuthMethod: 'password',
  sshPassword: '',
  sshPrivateKey: '',
  containerAuthMethod: 'none',
  containerBearerToken: '',
  k8sApiServerUrl: '',
  k8sNamespace: '',
  k8sBearerToken: '',
  vmHost: '',
  vmPort: '',
  vmUsername: '',
  vmAuthMethod: 'password',
  vmPassword: '',
  vmPrivateKey: '',
  labels: '',
  enabled: true,
  publicConfig: '',
  secretRefs: '',
};

const REMOTE_FLEET_TARGET_KIND_OPTIONS: readonly RemoteFleetNodeTargetKind[] = [
  'ssh-host',
  'container',
  'k8s-pod',
  'custom',
  'vm',
];

const PUBLIC_CONFIG_SECRET_KEY_PATTERN = /(?:token|password|authorization|api[-_]?key|secret|credential|private[-_]?key|ssh[-_]?private[-_]?key)/i;
const CONTAINER_IMAGE_SECRET_PATTERN = /(?:authorization\s*[:=]|bearer\s+[a-z0-9._~+/=-]+|:\/\/[^/\s]+:[^@\s]+@|(?:token|password|api[-_]?key|secret|credential)\s*[=:])/i;
const REGISTRATION_ERROR_KEY_PREFIX = 'remoteFleet.registration.errors.';

const SSH_AUTH_METHOD_OPTIONS: readonly SshAuthMethod[] = ['password', 'private-key'];
const CONTAINER_AUTH_METHOD_OPTIONS: readonly ContainerAuthMethod[] = ['none', 'bearer-token'];
const VM_AUTH_METHOD_OPTIONS: readonly VmAuthMethod[] = ['password', 'private-key'];

type NodeFormProviderHelper = {
  readonly publicConfigPlaceholderKey: string;
  readonly secretRefsPlaceholderKey: string;
};

const NODE_FORM_PROVIDER_HELPERS: Record<RemoteFleetNodeTargetKind, NodeFormProviderHelper> = {
  'ssh-host': {
    publicConfigPlaceholderKey: 'remoteFleet.registration.helpers.sshHost.publicConfigPlaceholder',
    secretRefsPlaceholderKey: 'remoteFleet.registration.helpers.sshHost.secretRefsPlaceholder',
  },
  container: {
    publicConfigPlaceholderKey: 'remoteFleet.registration.helpers.container.publicConfigPlaceholder',
    secretRefsPlaceholderKey: 'remoteFleet.registration.helpers.container.secretRefsPlaceholder',
  },
  'k8s-pod': {
    publicConfigPlaceholderKey: 'remoteFleet.registration.helpers.k8sPod.publicConfigPlaceholder',
    secretRefsPlaceholderKey: 'remoteFleet.registration.helpers.k8sPod.secretRefsPlaceholder',
  },
  custom: {
    publicConfigPlaceholderKey: 'remoteFleet.registration.helpers.custom.publicConfigPlaceholder',
    secretRefsPlaceholderKey: 'remoteFleet.registration.helpers.custom.secretRefsPlaceholder',
  },
  vm: {
    publicConfigPlaceholderKey: 'remoteFleet.registration.helpers.vm.publicConfigPlaceholder',
    secretRefsPlaceholderKey: 'remoteFleet.registration.helpers.vm.secretRefsPlaceholder',
  },
};

function parseLabels(value: string): string[] | undefined {
  const items = value.split(/[\n,，]+/).map((label) => label.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function assertSafeContainerImageValue(value: string): void {
  if (CONTAINER_IMAGE_SECRET_PATTERN.test(value)) {
    throw new Error('remoteFleet.registration.errors.containerImageSensitive');
  }
}

function parseOptionalContainerImage(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  assertSafeContainerImageValue(trimmed);
  return trimmed;
}

function parseContainerImageCandidates(value: string): string[] | undefined {
  const items = value.split(/[\n,，]+/).map((item) => item.trim()).filter(Boolean);
  for (const item of items) {
    assertSafeContainerImageValue(item);
  }
  return items.length > 0 ? items : undefined;
}

function parseSecretRefMap(value: string): Record<string, RemoteFleetSecretRef> | undefined {
  const entries = value.split('\n').map((line) => line.trim()).filter(Boolean);
  if (entries.length === 0) {
    return undefined;
  }

  const result: Record<string, RemoteFleetSecretRef> = {};
  for (const entry of entries) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0) {
      throw new Error('remoteFleet.registration.errors.secretRefFormat');
    }
    const key = entry.slice(0, separatorIndex).trim();
    const ref = entry.slice(separatorIndex + 1).trim();
    if (!key || !ref) {
      throw new Error('remoteFleet.registration.errors.secretRefRequired');
    }
    result[key] = { kind: 'secret-ref', ref };
  }
  return result;
}

function mergeSecretRefs(
  base: Record<string, RemoteFleetSecretRef> | undefined,
  typed: Record<string, RemoteFleetSecretRef> | undefined,
): Record<string, RemoteFleetSecretRef> | undefined {
  return undefinedIfEmpty(withoutUndefined({ ...(base ?? {}), ...(typed ?? {}) }));
}

type CredentialDraft = {
  readonly credentialName: WritableCredentialName;
  readonly plaintextValue: string;
};

function nodeCredentialId(form: NodeFormState): string {
  const seed = form.id
    || form.displayName
    || form.sshHost
    || form.vmHost
    || form.endpointUrl
    || form.k8sApiServerUrl
    || 'remote-node';
  const normalized = seed.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(normalized) ? normalized : 'remote-node';
}

function credentialDraftsFromForm(form: NodeFormState): readonly CredentialDraft[] {
  if (form.targetKind === 'ssh-host') {
    if (form.sshAuthMethod === 'password' && form.sshPassword.trim()) {
      return [{ credentialName: 'sshPassword', plaintextValue: form.sshPassword }];
    }
    if (form.sshAuthMethod === 'private-key' && form.sshPrivateKey.trim()) {
      return [{ credentialName: 'sshPrivateKey', plaintextValue: form.sshPrivateKey }];
    }
  }

  if (form.targetKind === 'container' && form.containerAuthMethod === 'bearer-token' && form.containerBearerToken.trim()) {
    return [{ credentialName: 'dockerBearerToken', plaintextValue: form.containerBearerToken }];
  }

  if (form.targetKind === 'k8s-pod' && form.k8sBearerToken.trim()) {
    return [{ credentialName: 'kubeBearerToken', plaintextValue: form.k8sBearerToken }];
  }

  if (form.targetKind === 'vm') {
    if (form.vmAuthMethod === 'password' && form.vmPassword.trim()) {
      return [{ credentialName: 'sshPassword', plaintextValue: form.vmPassword }];
    }
    if (form.vmAuthMethod === 'private-key' && form.vmPrivateKey.trim()) {
      return [{ credentialName: 'sshPrivateKey', plaintextValue: form.vmPrivateKey }];
    }
  }

  return [];
}

function hasSensitivePublicConfigKey(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some(hasSensitivePublicConfigKey);
  }

  return Object.entries(value).some(([key, nestedValue]) => {
    return PUBLIC_CONFIG_SECRET_KEY_PATTERN.test(key) || hasSensitivePublicConfigKey(nestedValue);
  });
}

function parsePublicConfig(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error('remoteFleet.registration.errors.publicConfigJson');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('remoteFleet.registration.errors.publicConfigObject');
  }
  if (hasSensitivePublicConfigKey(parsed)) {
    throw new Error('remoteFleet.registration.errors.publicConfigSecret');
  }
  return parsed as Record<string, unknown>;
}

function parseOptionalPort(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const port = Number(trimmed);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('remoteFleet.registration.errors.portNumber');
  }
  return port;
}

function isDockerLoopbackHttps2375Endpoint(endpointUrl: string): boolean {
  try {
    const url = new URL(endpointUrl);
    return url.protocol === 'https:'
      && url.port === '2375'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  } catch {
    return false;
  }
}

function parseOptionalK8sApiServerUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') {
      throw new Error('remoteFleet.registration.errors.k8sApiServerHttps');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
      throw new Error('remoteFleet.registration.errors.k8sApiServerOrigin');
    }
    return parsed.origin;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(REGISTRATION_ERROR_KEY_PREFIX)) {
      throw error;
    }
    throw new Error('remoteFleet.registration.errors.k8sApiServerOrigin', { cause: error });
  }
}

function withoutUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function undefinedIfEmpty<T extends Record<string, unknown>>(input: T): T | undefined {
  return Object.keys(input).length > 0 ? input : undefined;
}

function sshEndpointUrl(host: string, port?: number): string | undefined {
  const trimmedHost = host.trim();
  if (!trimmedHost) {
    return undefined;
  }

  return port ? `ssh://${trimmedHost}:${port}` : `ssh://${trimmedHost}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergePublicConfig(
  publicConfig: Record<string, unknown> | undefined,
  typedConfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = { ...(publicConfig ?? {}) };
  for (const [key, value] of Object.entries(typedConfig)) {
    if (value === undefined) continue;
    merged[key] = isPlainRecord(merged[key]) && isPlainRecord(value)
      ? { ...merged[key], ...value }
      : value;
  }
  return undefinedIfEmpty(withoutUndefined(merged));
}

function connectionRegistration(
  form: NodeFormState,
  credentialSecretRefs?: Record<string, RemoteFleetSecretRef>,
): RemoteFleetConnectionRegistration {
  const publicConfig = parsePublicConfig(form.publicConfig);
  const advancedSecretRefs = parseSecretRefMap(form.secretRefs);
  const targetKind = form.targetKind;
  const sshPort = targetKind === 'ssh-host'
    ? parseOptionalPort(form.sshPort)
    : targetKind === 'vm'
      ? parseOptionalPort(form.vmPort)
      : undefined;
  const endpointUrl = targetKind === 'ssh-host'
    ? sshEndpointUrl(form.sshHost, sshPort)
    : targetKind === 'vm'
      ? sshEndpointUrl(form.vmHost, sshPort)
      : targetKind === 'k8s-pod'
        ? parseOptionalK8sApiServerUrl(form.k8sApiServerUrl)
        : form.endpointUrl.trim() || undefined;
  if (targetKind === 'container' && isDockerLoopbackHttps2375Endpoint(endpointUrl ?? '')) {
    throw new Error('remoteFleet.registration.errors.dockerLoopbackHttps2375');
  }
  const providerConfig = targetKind === 'container'
    ? { docker: undefinedIfEmpty(withoutUndefined({
      endpointUrl,
      connectionSource: 'endpoint',
      authMethod: form.containerAuthMethod,
    })) }
    : targetKind === 'ssh-host'
      ? { ssh: undefinedIfEmpty(withoutUndefined({
        host: form.sshHost.trim() || undefined,
        port: sshPort,
        username: form.sshUsername.trim() || undefined,
      })) }
      : targetKind === 'vm'
        ? { vm: undefinedIfEmpty(withoutUndefined({
          host: form.vmHost.trim() || undefined,
          port: sshPort,
          username: form.vmUsername.trim() || undefined,
          loginMethod: form.vmAuthMethod,
        })) }
        : targetKind === 'k8s-pod'
          ? { k8s: undefinedIfEmpty(withoutUndefined({ apiServerUrl: endpointUrl })) }
          : {};
  const displayNameSeed = targetKind === 'ssh-host'
    ? form.sshHost
    : targetKind === 'vm'
      ? form.vmHost
      : targetKind === 'k8s-pod'
        ? form.k8sApiServerUrl
        : form.endpointUrl;

  return withoutUndefined({
    id: form.id.trim() || undefined,
    displayName: form.displayName.trim() || displayNameFromEndpointUrl(displayNameSeed) || undefined,
    connectionKind: targetKind,
    targetKind,
    endpointUrl,
    labels: parseLabels(form.labels),
    enabled: form.enabled,
    publicConfig: mergePublicConfig(publicConfig, providerConfig),
    secretRefs: mergeSecretRefs(advancedSecretRefs, credentialSecretRefs),
  });
}

function environmentRegistration(
  form: NodeFormState,
  connectionId: string,
): RemoteFleetEnvironmentRegistration {
  const targetKind = form.targetKind;
  const environmentKind = targetKind === 'container'
    ? 'docker-container'
    : targetKind === 'ssh-host'
      ? 'ssh-workdir'
      : targetKind === 'vm'
        ? 'vm-workdir'
        : targetKind === 'k8s-pod'
          ? 'k8s-workload'
          : 'custom';
  const providerConfig = targetKind === 'container'
    ? { docker: undefinedIfEmpty(withoutUndefined({
      containerName: form.containerName.trim() || undefined,
      image: parseOptionalContainerImage(form.containerImage),
      imageCandidates: parseContainerImageCandidates(form.containerImageCandidates),
    })) }
    : targetKind === 'k8s-pod'
      ? { k8s: undefinedIfEmpty(withoutUndefined({ namespace: form.k8sNamespace.trim() || undefined })) }
      : {};
  const displayNameSeed = targetKind === 'container'
    ? form.containerName || form.endpointUrl
    : targetKind === 'ssh-host'
      ? form.sshHost
      : targetKind === 'vm'
        ? form.vmHost
        : targetKind === 'k8s-pod'
          ? form.k8sApiServerUrl
          : form.endpointUrl;

  return withoutUndefined({
    connectionId,
    displayName: form.displayName.trim() || displayNameFromEndpointUrl(displayNameSeed) || undefined,
    environmentKind,
    targetKind,
    labels: parseLabels(form.labels),
    enabled: form.enabled,
    publicConfig: undefinedIfEmpty(withoutUndefined(providerConfig)),
  });
}

function connectionIdFromRegistrationResult(payload: RemoteFleetActionPayload): string {
  if (!payload.connection?.id) {
    throw new Error('remoteFleet.registration.errors.connectionIdMissing');
  }
  return payload.connection.id;
}

function environmentIdFromRegistrationResult(payload: RemoteFleetActionPayload): string {
  if (!payload.environment?.id) {
    throw new Error('remoteFleet.registration.errors.environmentIdMissing');
  }
  return payload.environment.id;
}

function resolveRegistrationErrorMessage(error: unknown, translate: (key: string) => string): string {
  if (error instanceof Error && error.message.startsWith(REGISTRATION_ERROR_KEY_PREFIX)) {
    return translate(error.message);
  }

  return translate('remoteFleet.registration.toast.failed');
}

function displayNameFromEndpointUrl(endpointUrl: string): string {
  const trimmed = endpointUrl.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.hostname || trimmed;
  } catch {
    return trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/:?#]/)[0] || trimmed;
  }
}

function clearCredentialDrafts(form: NodeFormState): NodeFormState {
  return {
    ...form,
    sshPassword: '',
    sshPrivateKey: '',
    containerBearerToken: '',
    k8sBearerToken: '',
    vmPassword: '',
    vmPrivateKey: '',
  };
}

function sshFormValuesFromEndpoint(endpointUrl: string | undefined): Pick<NodeFormState, 'sshHost' | 'sshPort' | 'sshUsername'> {
  if (!endpointUrl) {
    return { sshHost: '', sshPort: '', sshUsername: '' };
  }

  try {
    const endpoint = new URL(endpointUrl);
    if (endpoint.protocol !== 'ssh:') {
      return { sshHost: '', sshPort: '', sshUsername: '' };
    }
    return {
      sshHost: endpoint.hostname,
      sshPort: endpoint.port,
      sshUsername: endpoint.username ? decodeURIComponent(endpoint.username) : '',
    };
  } catch {
    return { sshHost: '', sshPort: '', sshUsername: '' };
  }
}

function formFromEditingConnection(connection: RemoteFleetConnectionSummary): NodeFormState {
  const targetKind = connection.targetKind ?? connection.connectionKind ?? 'ssh-host';
  const sshValues = sshFormValuesFromEndpoint(connection.endpointUrl);
  return {
    ...EMPTY_NODE_FORM,
    id: connection.id,
    displayName: connection.displayName ?? '',
    targetKind,
    endpointUrl: connection.endpointUrl ?? '',
    ...(targetKind === 'ssh-host' ? sshValues : {}),
    ...(targetKind === 'vm' ? {
      vmHost: sshValues.sshHost,
      vmPort: sshValues.sshPort,
      vmUsername: sshValues.sshUsername,
    } : {}),
    ...(targetKind === 'k8s-pod' ? { k8sApiServerUrl: connection.endpointUrl ?? '' } : {}),
    labels: connection.labels?.join(', ') ?? '',
    enabled: connection.enabled ?? true,
  };
}

async function writeCredentialDrafts(
  form: NodeFormState,
  operationIdsByCredentialDraft: Map<WritableCredentialName, string>,
  onWriteCredential: (input: RemoteFleetCredentialWriteInput) => Promise<RemoteFleetCredentialWriteResult>,
): Promise<Record<string, RemoteFleetSecretRef> | undefined> {
  const drafts = credentialDraftsFromForm(form);
  if (drafts.length === 0) {
    return undefined;
  }

  const credentialId = nodeCredentialId(form);
  const secretRefs: Record<string, RemoteFleetSecretRef> = {};
  for (const draft of drafts) {
    const operationId = operationIdsByCredentialDraft.get(draft.credentialName) ?? crypto.randomUUID();
    operationIdsByCredentialDraft.set(draft.credentialName, operationId);
    const result = await onWriteCredential({
      operationId,
      credentialId,
      credentialName: draft.credentialName,
      plaintextValue: draft.plaintextValue,
    });
    secretRefs[result.credentialName] = result.credentialRef;
  }
  return undefinedIfEmpty(secretRefs);
}

export interface RemoteFleetRegistrationSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly editingConnection?: RemoteFleetConnectionSummary;
  readonly connections: readonly RemoteFleetConnectionSummary[];
  readonly onRegisterConnection: (connection: RemoteFleetConnectionRegistration) => Promise<RemoteFleetActionPayload>;
  readonly onRegisterEnvironment: (environment: RemoteFleetEnvironmentRegistration) => Promise<RemoteFleetActionPayload>;
  readonly onDeployEnvironment: (environmentId: string) => Promise<RemoteFleetActionPayload>;
  readonly onWriteCredential: (input: RemoteFleetCredentialWriteInput) => Promise<RemoteFleetCredentialWriteResult>;
  readonly mutating: boolean;
}

function findReusableConnection(
  connections: readonly RemoteFleetConnectionSummary[],
  registration: RemoteFleetConnectionRegistration,
): RemoteFleetConnectionSummary | undefined {
  if (!registration.endpointUrl) return undefined;
  return connections.find((connection) => (
    connection.connectionKind === registration.connectionKind
    && connection.endpointUrl === registration.endpointUrl
    && connection.enabled !== false
  ));
}

export function RemoteFleetRegistrationSheet({
  open,
  onOpenChange,
  editingConnection,
  connections,
  onRegisterConnection,
  onRegisterEnvironment,
  onDeployEnvironment,
  onWriteCredential,
  mutating,
}: RemoteFleetRegistrationSheetProps) {
  const { t } = useTranslation();
  const isEditingConnection = editingConnection !== undefined;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [form, setForm] = useState<NodeFormState>(EMPTY_NODE_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [registeredEnvironmentId, setRegisteredEnvironmentId] = useState<string | null>(null);
  const [deploymentError, setDeploymentError] = useState<string | null>(null);
  const submitInFlightRef = useRef(false);
  const deployInFlightRef = useRef(false);
  const credentialOperationIdsRef = useRef(new Map<WritableCredentialName, string>());
  const providerHelper = useMemo(() => NODE_FORM_PROVIDER_HELPERS[form.targetKind], [form.targetKind]);
  const isSshRegistration = form.targetKind === 'ssh-host';
  const isContainerRegistration = form.targetKind === 'container';
  const isK8sRegistration = form.targetKind === 'k8s-pod';
  const isCustomRegistration = form.targetKind === 'custom';
  const isVmRegistration = form.targetKind === 'vm';
  const submitSeed = isSshRegistration
    ? form.sshHost
    : isVmRegistration
      ? form.vmHost
      : isK8sRegistration
        ? form.k8sApiServerUrl
        : form.endpointUrl;
  const canSubmit = Boolean(submitSeed.trim() || form.id.trim());

  const update = <K extends keyof NodeFormState>(key: K, value: NodeFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const updateTargetKind = (value: RemoteFleetNodeTargetKind) => {
    credentialOperationIdsRef.current.clear();
    setForm((current) => clearCredentialDrafts({ ...current, targetKind: value }));
  };

  const updateEndpointUrl = (value: string) => {
    setForm((current) => ({
      ...current,
      endpointUrl: value,
      displayName: current.displayName.trim() ? current.displayName : displayNameFromEndpointUrl(value),
    }));
  };

  const updateSshHost = (value: string) => {
    setForm((current) => ({
      ...current,
      sshHost: value,
      displayName: current.displayName.trim() ? current.displayName : value.trim(),
    }));
  };

  const updateVmHost = (value: string) => {
    setForm((current) => ({
      ...current,
      vmHost: value,
      displayName: current.displayName.trim() ? current.displayName : value.trim(),
    }));
  };

  const updateK8sApiServerUrl = (value: string) => {
    setForm((current) => ({
      ...current,
      k8sApiServerUrl: value,
      displayName: current.displayName.trim() ? current.displayName : displayNameFromEndpointUrl(value),
    }));
  };

  const resetRegistrationDraft = useCallback(() => {
    credentialOperationIdsRef.current.clear();
    setForm(EMPTY_NODE_FORM);
    setAdvancedOpen(false);
    setFormError(null);
    setRegisteredEnvironmentId(null);
    setDeploymentError(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    credentialOperationIdsRef.current.clear();
    setForm(editingConnection ? formFromEditingConnection(editingConnection) : EMPTY_NODE_FORM);
    setAdvancedOpen(false);
    setFormError(null);
    setRegisteredEnvironmentId(null);
    setDeploymentError(null);
  }, [editingConnection, open]);

  const closeRegistrationSheet = useCallback(() => {
    resetRegistrationDraft();
    onOpenChange(false);
  }, [onOpenChange, resetRegistrationDraft]);

  const updateOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      if (registeredEnvironmentId) {
        closeRegistrationSheet();
      } else {
        credentialOperationIdsRef.current.clear();
        setForm((current) => clearCredentialDrafts(current));
        setFormError(null);
        setDeploymentError(null);
        onOpenChange(false);
      }
      return;
    }
    onOpenChange(true);
  };

  const submit = useCallback(async () => {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;

    try {
      setFormError(null);
      const registration = connectionRegistration(form);

      if (isEditingConnection) {
        const credentialSecretRefs = await writeCredentialDrafts(form, credentialOperationIdsRef.current, onWriteCredential);
        await onRegisterConnection({
          ...registration,
          ...(credentialSecretRefs ? { secretRefs: credentialSecretRefs } : {}),
        });
        credentialOperationIdsRef.current.clear();
        setForm((current) => clearCredentialDrafts(current));
        toast.success(t('remoteFleet.registration.toast.connectionSaved'));
        closeRegistrationSheet();
        return;
      }

      const reusableConnection = findReusableConnection(connections, registration);
      const credentialSecretRefs = await writeCredentialDrafts(form, credentialOperationIdsRef.current, onWriteCredential);
      const connectionId = reusableConnection && !credentialSecretRefs
        ? reusableConnection.id
        : connectionIdFromRegistrationResult(
          await onRegisterConnection(connectionRegistration({
            ...form,
            ...(reusableConnection ? { id: reusableConnection.id } : {}),
          }, credentialSecretRefs)),
        );
      const environmentId = environmentIdFromRegistrationResult(
        await onRegisterEnvironment(environmentRegistration(form, connectionId)),
      );
      credentialOperationIdsRef.current.clear();
      setForm((current) => clearCredentialDrafts(current));
      if (form.targetKind === 'custom') {
        toast.success(t('remoteFleet.registration.toast.submitted'));
        closeRegistrationSheet();
        return;
      }
      setRegisteredEnvironmentId(environmentId);
      toast.success(t('remoteFleet.registration.toast.submitted'));
    } catch (error) {
      const message = resolveRegistrationErrorMessage(error, t);
      setFormError(message);
      toast.error(message);
    } finally {
      submitInFlightRef.current = false;
    }
  }, [closeRegistrationSheet, connections, form, isEditingConnection, onRegisterConnection, onRegisterEnvironment, onWriteCredential, t]);

  const deployRegisteredEnvironment = useCallback(async () => {
    if (!registeredEnvironmentId || deployInFlightRef.current) return;
    deployInFlightRef.current = true;

    try {
      setDeploymentError(null);
      const payload = await onDeployEnvironment(registeredEnvironmentId);
      const outcome = remoteFleetCommandOutcome(payload.command);
      if (outcome === 'failed' || outcome === 'missing') {
        setDeploymentError(t('remoteFleet.registration.environmentRegistered.deploymentFailed'));
        return;
      }
      closeRegistrationSheet();
    } catch {
      setDeploymentError(t('remoteFleet.registration.environmentRegistered.deploymentFailed'));
    } finally {
      deployInFlightRef.current = false;
    }
  }, [closeRegistrationSheet, onDeployEnvironment, registeredEnvironmentId, t]);

  return (
    <Sheet open={open} onOpenChange={updateOpen}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{t('remoteFleet.registration.title')}</SheetTitle>
          <SheetDescription>{t('remoteFleet.registration.description')}</SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-4 pb-6">
          {registeredEnvironmentId ? (
            <div className="space-y-4">
              <div className="flex gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">
                    {t('remoteFleet.registration.environmentRegistered.title')}
                  </p>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t('remoteFleet.registration.environmentRegistered.description')}
                  </p>
                </div>
              </div>

              {deploymentError ? (
                <p className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {deploymentError}
                </p>
              ) : null}

              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" onClick={closeRegistrationSheet} disabled={mutating}>
                  {t('remoteFleet.registration.environmentRegistered.deployLater')}
                </Button>
                <Button onClick={() => void deployRegisteredEnvironment()} disabled={mutating}>
                  {mutating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                  {t('remoteFleet.registration.environmentRegistered.deployNow')}
                </Button>
              </div>
            </div>
          ) : (
            <>
          {formError ? (
            <p className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {formError}
            </p>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="remote-node-target-kind">{t('remoteFleet.registration.fields.targetKind')}</Label>
              <Select
                id="remote-node-target-kind"
                value={form.targetKind}
                disabled={isEditingConnection}
                onChange={(event) => updateTargetKind(event.target.value as RemoteFleetNodeTargetKind)}
              >
                {REMOTE_FLEET_TARGET_KIND_OPTIONS.map((targetKind) => (
                  <option key={targetKind} value={targetKind}>{t(`remoteFleet.registration.targetKinds.${targetKind}`)}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="remote-node-name">{t('remoteFleet.registration.fields.displayName')}</Label>
              <Input id="remote-node-name" value={form.displayName} onChange={(event) => update('displayName', event.target.value)} placeholder={t('remoteFleet.registration.placeholders.displayName')} />
            </div>
          </div>

          {isSshRegistration ? (
            <div className="space-y-4 rounded-xl border border-border/70 p-4">
              <p className="text-sm font-medium">{t('remoteFleet.registration.ssh.title')}</p>
              <div className="grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                <div className="space-y-2">
                  <Label htmlFor="remote-node-ssh-host">{t('remoteFleet.registration.ssh.fields.host')}</Label>
                  <Input id="remote-node-ssh-host" value={form.sshHost} onChange={(event) => updateSshHost(event.target.value)} placeholder={t('remoteFleet.registration.ssh.placeholders.host')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="remote-node-ssh-port">{t('remoteFleet.registration.ssh.fields.port')}</Label>
                  <Input id="remote-node-ssh-port" inputMode="numeric" value={form.sshPort} onChange={(event) => update('sshPort', event.target.value)} placeholder={t('remoteFleet.registration.ssh.placeholders.port')} />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="remote-node-ssh-username">{t('remoteFleet.registration.ssh.fields.username')}</Label>
                  <Input id="remote-node-ssh-username" value={form.sshUsername} onChange={(event) => update('sshUsername', event.target.value)} placeholder={t('remoteFleet.registration.ssh.placeholders.username')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="remote-node-ssh-auth-method">{t('remoteFleet.registration.ssh.auth.label')}</Label>
                  <Select
                    id="remote-node-ssh-auth-method"
                    value={form.sshAuthMethod}
                    onChange={(event) => {
                      const method = event.target.value as SshAuthMethod;
                      credentialOperationIdsRef.current.clear();
                      setForm((current) => ({ ...current, sshAuthMethod: method, sshPassword: '', sshPrivateKey: '' }));
                    }}
                  >
                    {SSH_AUTH_METHOD_OPTIONS.map((method) => (
                      <option key={method} value={method}>{t(`remoteFleet.registration.ssh.auth.methods.${method}`)}</option>
                    ))}
                  </Select>
                </div>
              </div>
              {form.sshAuthMethod === 'password' ? (
                <div className="space-y-2">
                  <Label htmlFor="remote-node-ssh-password">{t('remoteFleet.registration.ssh.auth.fields.password')}</Label>
                  <Input id="remote-node-ssh-password" type="password" value={form.sshPassword} onChange={(event) => update('sshPassword', event.target.value)} placeholder={t('remoteFleet.registration.ssh.auth.placeholders.password')} />
                </div>
              ) : null}
              {form.sshAuthMethod === 'private-key' ? (
                <div className="space-y-2">
                  <Label htmlFor="remote-node-ssh-private-key">{t('remoteFleet.registration.ssh.auth.fields.privateKey')}</Label>
                  <Textarea id="remote-node-ssh-private-key" value={form.sshPrivateKey} onChange={(event) => update('sshPrivateKey', event.target.value)} placeholder={t('remoteFleet.registration.ssh.auth.placeholders.privateKey')} />
                </div>
              ) : null}
            </div>
          ) : null}

          {isContainerRegistration ? (
            <div className="space-y-4 rounded-xl border border-border/70 p-4">
              <p className="text-sm font-medium">{t('remoteFleet.registration.container.title')}</p>
              <div className="space-y-2">
                <Label htmlFor="remote-node-container-auth">{t('remoteFleet.registration.container.fields.authentication')}</Label>
                <Select
                  id="remote-node-container-auth"
                  value={form.containerAuthMethod}
                  onChange={(event) => {
                    credentialOperationIdsRef.current.clear();
                    setForm((current) => ({ ...current, containerAuthMethod: event.target.value as ContainerAuthMethod, containerBearerToken: '' }));
                  }}
                >
                  {CONTAINER_AUTH_METHOD_OPTIONS.map((method) => (
                    <option key={method} value={method}>{t(`remoteFleet.registration.container.authMethods.${method}`)}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="remote-node-container-endpoint">{t('remoteFleet.registration.fields.dockerEndpoint')}</Label>
                <Input id="remote-node-container-endpoint" value={form.endpointUrl} onChange={(event) => updateEndpointUrl(event.target.value)} placeholder={t('remoteFleet.registration.helpers.container.endpointUrlPlaceholder')} />
                <p className="text-xs leading-5 text-muted-foreground">{t('remoteFleet.registration.container.help.endpoint')}</p>
              </div>
              {!isEditingConnection ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="remote-node-container-name">{t('remoteFleet.registration.container.fields.containerName')}</Label>
                    <Input id="remote-node-container-name" value={form.containerName} onChange={(event) => update('containerName', event.target.value)} placeholder={t('remoteFleet.registration.container.placeholders.containerName')} />
                    <p className="text-xs leading-5 text-muted-foreground">{t('remoteFleet.registration.container.help.containerName')}</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="remote-node-container-image">{t('remoteFleet.registration.container.fields.image')}</Label>
                    <Input id="remote-node-container-image" value={form.containerImage} onChange={(event) => update('containerImage', event.target.value)} placeholder={t('remoteFleet.registration.container.placeholders.image')} />
                    <p className="text-xs leading-5 text-muted-foreground">{t('remoteFleet.registration.container.help.image')}</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="remote-node-container-image-candidates">{t('remoteFleet.registration.container.fields.imageCandidates')}</Label>
                    <Textarea id="remote-node-container-image-candidates" value={form.containerImageCandidates} onChange={(event) => update('containerImageCandidates', event.target.value)} placeholder={t('remoteFleet.registration.container.placeholders.imageCandidates')} />
                    <p className="text-xs leading-5 text-muted-foreground">{t('remoteFleet.registration.container.help.imageCandidates')}</p>
                  </div>
                </>
              ) : null}
              {form.containerAuthMethod === 'bearer-token' ? (
                <div className="space-y-2">
                  <Label htmlFor="remote-node-container-bearer-token">{t('remoteFleet.registration.container.fields.bearerToken')}</Label>
                  <Input id="remote-node-container-bearer-token" type="password" value={form.containerBearerToken} onChange={(event) => update('containerBearerToken', event.target.value)} placeholder={t('remoteFleet.registration.container.placeholders.bearerToken')} />
                </div>
              ) : null}
            </div>
          ) : null}

          {isK8sRegistration ? (
            <div className="space-y-4 rounded-xl border border-border/70 p-4">
              <p className="text-sm font-medium">{t('remoteFleet.registration.k8s.connection.title')}</p>
              <div className="grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                <div className="space-y-2">
                  <Label htmlFor="remote-node-k8s-api-server">{t('remoteFleet.registration.k8s.fields.apiServerUrl')}</Label>
                  <Input id="remote-node-k8s-api-server" value={form.k8sApiServerUrl} onChange={(event) => updateK8sApiServerUrl(event.target.value)} placeholder={t('remoteFleet.registration.helpers.k8sPod.endpointUrlPlaceholder')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="remote-node-k8s-namespace">{t('remoteFleet.registration.k8s.fields.namespace')}</Label>
                  <Input id="remote-node-k8s-namespace" value={form.k8sNamespace} onChange={(event) => update('k8sNamespace', event.target.value)} placeholder={t('remoteFleet.registration.k8s.placeholders.namespace')} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="remote-node-k8s-token">{t('remoteFleet.registration.k8s.fields.bearerToken')}</Label>
                <Input id="remote-node-k8s-token" type="password" value={form.k8sBearerToken} onChange={(event) => update('k8sBearerToken', event.target.value)} placeholder={t('remoteFleet.registration.k8s.placeholders.bearerToken')} />
              </div>
            </div>
          ) : null}

          {isCustomRegistration ? (
            <div className="space-y-4 rounded-xl border border-border/70 p-4">
              <p className="text-sm font-medium">{t('remoteFleet.registration.custom.title')}</p>
              <div className="space-y-2">
                <Label htmlFor="remote-node-custom-endpoint">{t('remoteFleet.registration.custom.fields.endpointUrl')}</Label>
                <Input id="remote-node-custom-endpoint" value={form.endpointUrl} onChange={(event) => updateEndpointUrl(event.target.value)} placeholder={t('remoteFleet.registration.helpers.custom.endpointUrlPlaceholder')} />
              </div>
            </div>
          ) : null}

          {isVmRegistration ? (
            <div className="space-y-4 rounded-xl border border-border/70 p-4">
              <p className="text-sm font-medium">{t('remoteFleet.registration.vm.title')}</p>
              <div className="grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                <div className="space-y-2">
                  <Label htmlFor="remote-node-vm-host">{t('remoteFleet.registration.vm.fields.host')}</Label>
                  <Input id="remote-node-vm-host" value={form.vmHost} onChange={(event) => updateVmHost(event.target.value)} placeholder={t('remoteFleet.registration.vm.placeholders.host')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="remote-node-vm-port">{t('remoteFleet.registration.vm.fields.port')}</Label>
                  <Input id="remote-node-vm-port" inputMode="numeric" value={form.vmPort} onChange={(event) => update('vmPort', event.target.value)} placeholder={t('remoteFleet.registration.vm.placeholders.port')} />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="remote-node-vm-username">{t('remoteFleet.registration.vm.fields.username')}</Label>
                  <Input id="remote-node-vm-username" value={form.vmUsername} onChange={(event) => update('vmUsername', event.target.value)} placeholder={t('remoteFleet.registration.vm.placeholders.username')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="remote-node-vm-auth">{t('remoteFleet.registration.vm.fields.loginMethod')}</Label>
                  <Select
                    id="remote-node-vm-auth"
                    value={form.vmAuthMethod}
                    onChange={(event) => {
                      credentialOperationIdsRef.current.clear();
                      setForm((current) => ({ ...current, vmAuthMethod: event.target.value as VmAuthMethod, vmPassword: '', vmPrivateKey: '' }));
                    }}
                  >
                    {VM_AUTH_METHOD_OPTIONS.map((method) => (
                      <option key={method} value={method}>{t(`remoteFleet.registration.vm.loginMethods.${method}`)}</option>
                    ))}
                  </Select>
                </div>
              </div>
              {form.vmAuthMethod === 'password' ? (
                <div className="space-y-2">
                  <Label htmlFor="remote-node-vm-password">{t('remoteFleet.registration.vm.credentials.password')}</Label>
                  <Input id="remote-node-vm-password" type="password" value={form.vmPassword} onChange={(event) => update('vmPassword', event.target.value)} />
                </div>
              ) : null}
              {form.vmAuthMethod === 'private-key' ? (
                <div className="space-y-2">
                  <Label htmlFor="remote-node-vm-private-key">{t('remoteFleet.registration.vm.credentials.privateKey')}</Label>
                  <Textarea id="remote-node-vm-private-key" value={form.vmPrivateKey} onChange={(event) => update('vmPrivateKey', event.target.value)} />
                </div>
              ) : null}
              <div className="rounded-lg border border-border bg-muted/20 p-3">
                <p className="text-xs font-medium text-foreground">{t('remoteFleet.registration.vm.cloudDiscovery.title')}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('remoteFleet.registration.vm.cloudDiscovery.description')}</p>
              </div>
            </div>
          ) : null}

          {isEditingConnection ? (
            <div className="space-y-4 rounded-xl border border-border/70 bg-muted/20 p-4">
              <div className="space-y-2">
                <Label htmlFor="remote-node-edit-labels">{t('remoteFleet.registration.fields.labels')}</Label>
                <Input id="remote-node-edit-labels" value={form.labels} onChange={(event) => update('labels', event.target.value)} placeholder={t('remoteFleet.registration.placeholders.labels')} />
                <p className="text-xs leading-5 text-muted-foreground">{t('remoteFleet.registration.fieldHelp.labels')}</p>
              </div>
              <div className="flex items-center justify-between rounded-xl border border-border bg-background px-4 py-3">
                <div>
                  <Label>{t('remoteFleet.registration.enabled.label')}</Label>
                  <p className="text-xs text-muted-foreground">{t('remoteFleet.registration.enabled.description')}</p>
                </div>
                <Switch checked={form.enabled} onCheckedChange={(checked) => update('enabled', checked)} />
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-border/70 bg-muted/20">
              <Button
                aria-expanded={advancedOpen}
                className="h-auto w-full justify-between px-4 py-3 text-left hover:bg-muted/40"
                variant="ghost"
                onClick={() => setAdvancedOpen((current) => !current)}
              >
                <span>
                  <span className="block text-sm font-medium text-foreground">{t('remoteFleet.registration.advanced.title')}</span>
                  <span className="mt-1 block whitespace-normal text-xs font-normal leading-5 text-muted-foreground">{t('remoteFleet.registration.advanced.description')}</span>
                </span>
                <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', advancedOpen && 'rotate-180')} />
              </Button>

            {advancedOpen ? (
              <div className="space-y-4 border-t border-border/70 p-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="remote-node-id">{t('remoteFleet.registration.fields.id')}</Label>
                    <Input id="remote-node-id" value={form.id} onChange={(event) => update('id', event.target.value)} placeholder={t('remoteFleet.registration.placeholders.id')} />
                    <p className="text-xs leading-5 text-muted-foreground">{t('remoteFleet.registration.fieldHelp.id')}</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="remote-node-labels">{t('remoteFleet.registration.fields.labels')}</Label>
                    <Input id="remote-node-labels" value={form.labels} onChange={(event) => update('labels', event.target.value)} placeholder={t('remoteFleet.registration.placeholders.labels')} />
                    <p className="text-xs leading-5 text-muted-foreground">{t('remoteFleet.registration.fieldHelp.labels')}</p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="remote-node-secrets">{t('remoteFleet.registration.fields.secretRefs')}</Label>
                  <Textarea id="remote-node-secrets" value={form.secretRefs} onChange={(event) => update('secretRefs', event.target.value)} placeholder={t(providerHelper.secretRefsPlaceholderKey)} />
                  <p className="text-xs text-muted-foreground">{t('remoteFleet.registration.secretRefBoundary')}</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="remote-node-public-config">{t('remoteFleet.registration.fields.publicConfig')}</Label>
                  <Textarea id="remote-node-public-config" value={form.publicConfig} onChange={(event) => update('publicConfig', event.target.value)} placeholder={t(providerHelper.publicConfigPlaceholderKey)} />
                  <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700">
                    {t('remoteFleet.registration.publicConfigWarning')}
                  </p>
                </div>

                <div className="flex items-center justify-between rounded-xl border border-border bg-background px-4 py-3">
                  <div>
                    <Label>{t('remoteFleet.registration.enabled.label')}</Label>
                    <p className="text-xs text-muted-foreground">{t('remoteFleet.registration.enabled.description')}</p>
                  </div>
                  <Switch checked={form.enabled} onCheckedChange={(checked) => update('enabled', checked)} />
                </div>
              </div>
              ) : null}
            </div>
          )}

          <div className="flex justify-end">
            <Button onClick={() => void submit()} disabled={mutating || !canSubmit}>
              {mutating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {t('remoteFleet.registration.submit')}
            </Button>
          </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default RemoteFleetRegistrationSheet;
