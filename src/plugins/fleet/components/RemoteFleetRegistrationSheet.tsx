import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
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
import { useContributions } from '@/plugin-host/react';
import { fleetRegistrationTargets, type FleetCredentialName, type FleetRegistrationTarget } from '../extensions';
import {
  clearCredentialDrafts,
  connectionRegistration,
  EMPTY_NODE_FORM,
  environmentRegistration,
  formFromEditingConnection,
  nodeCredentialId,
  REGISTRATION_ERROR_KEY_PREFIX,
  undefinedIfEmpty,
  type FleetRegistrationFormState,
} from '../registration/form';
import {
  remoteFleetCommandOutcome,
  type RemoteFleetActionPayload,
  type RemoteFleetConnectionRegistration,
  type RemoteFleetConnectionSummary,
  type RemoteFleetCredentialWriteInput,
  type RemoteFleetCredentialWriteResult,
  type RemoteFleetEnvironmentRegistration,
  type RemoteFleetNodeTargetKind,
  type RemoteFleetSecretRef,
} from '../store';

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

async function writeCredentialDrafts(
  form: FleetRegistrationFormState,
  target: FleetRegistrationTarget,
  operationIdsByCredentialDraft: Map<FleetCredentialName, string>,
  onWriteCredential: (input: RemoteFleetCredentialWriteInput) => Promise<RemoteFleetCredentialWriteResult>,
): Promise<Record<string, RemoteFleetSecretRef> | undefined> {
  const drafts = target.credentialDrafts(form);
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
  const [form, setForm] = useState<FleetRegistrationFormState>(EMPTY_NODE_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [registeredEnvironmentId, setRegisteredEnvironmentId] = useState<string | null>(null);
  const [deploymentError, setDeploymentError] = useState<string | null>(null);
  const formIncarnationRef = useRef(0);
  const submitInFlightRef = useRef(false);
  const deployInFlightRef = useRef(false);
  const credentialOperationIdsRef = useRef(new Map<FleetCredentialName, string>());
  const registrationTargets = useContributions(fleetRegistrationTargets);
  const target = registrationTargets.find((target) => target.kind === form.targetKind)!;
  const Fields = target.fields;
  const canSubmit = Boolean(target.submitSeed(form).trim() || form.id.trim());

  const update = <K extends keyof FleetRegistrationFormState>(key: K, value: FleetRegistrationFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const clearCredentialOperationIds = useCallback(() => {
    credentialOperationIdsRef.current.clear();
  }, []);

  const updateTargetKind = (value: RemoteFleetNodeTargetKind) => {
    credentialOperationIdsRef.current.clear();
    setForm((current) => clearCredentialDrafts({ ...current, targetKind: value }));
  };

  const resetRegistrationDraft = useCallback(() => {
    formIncarnationRef.current += 1;
    credentialOperationIdsRef.current.clear();
    setForm(EMPTY_NODE_FORM);
    setAdvancedOpen(false);
    setFormError(null);
    setRegisteredEnvironmentId(null);
    setDeploymentError(null);
  }, []);

  useEffect(() => {
    formIncarnationRef.current += 1;
    if (!open) return;
    credentialOperationIdsRef.current.clear();
    setForm(editingConnection ? formFromEditingConnection(editingConnection, registrationTargets.find((target) => (
      target.kind === (editingConnection.targetKind ?? editingConnection.connectionKind ?? 'ssh-host')
    ))!) : EMPTY_NODE_FORM);
    setAdvancedOpen(false);
    setFormError(null);
    setRegisteredEnvironmentId(null);
    setDeploymentError(null);
    return () => { formIncarnationRef.current += 1; };
  }, [editingConnection, open, registrationTargets]);

  const closeRegistrationSheet = useCallback(() => {
    resetRegistrationDraft();
    onOpenChange(false);
  }, [onOpenChange, resetRegistrationDraft]);

  const updateOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      formIncarnationRef.current += 1;
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
    const formIncarnation = formIncarnationRef.current;

    try {
      setFormError(null);
      const registration = connectionRegistration(form, target);

      if (isEditingConnection) {
        const credentialSecretRefs = await writeCredentialDrafts(form, target, credentialOperationIdsRef.current, onWriteCredential);
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
      const credentialSecretRefs = await writeCredentialDrafts(form, target, credentialOperationIdsRef.current, onWriteCredential);
      const connectionId = reusableConnection && !credentialSecretRefs
        ? reusableConnection.id
        : connectionIdFromRegistrationResult(
          await onRegisterConnection(connectionRegistration({
            ...form,
            ...(reusableConnection ? { id: reusableConnection.id } : {}),
          }, target, credentialSecretRefs)),
        );
      const environmentId = environmentIdFromRegistrationResult(
        await onRegisterEnvironment(environmentRegistration(form, target, connectionId)),
      );
      credentialOperationIdsRef.current.clear();
      setForm((current) => clearCredentialDrafts(current));
      if (!target.confirmDeployment) {
        toast.success(t('remoteFleet.registration.toast.submitted'));
        closeRegistrationSheet();
        return;
      }
      setRegisteredEnvironmentId(environmentId);
      toast.success(t('remoteFleet.registration.toast.submitted'));
    } catch (error) {
      if (formIncarnation !== formIncarnationRef.current) return;
      const message = resolveRegistrationErrorMessage(error, t);
      setFormError(message);
      toast.error(message);
    } finally {
      submitInFlightRef.current = false;
    }
  }, [closeRegistrationSheet, connections, form, isEditingConnection, onRegisterConnection, onRegisterEnvironment, onWriteCredential, t, target]);

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
                {registrationTargets.map(({ kind }) => (
                  <option key={kind} value={kind}>{t(`remoteFleet.registration.targetKinds.${kind}`)}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="remote-node-name">{t('remoteFleet.registration.fields.displayName')}</Label>
              <Input id="remote-node-name" value={form.displayName} onChange={(event) => update('displayName', event.target.value)} placeholder={t('remoteFleet.registration.placeholders.displayName')} />
            </div>
          </div>

          <Suspense fallback={<Loader2 className="h-4 w-4 animate-spin" />}>
            <Fields form={form} editing={isEditingConnection} setForm={setForm} clearCredentialOperationIds={clearCredentialOperationIds} />
          </Suspense>

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
                  <Textarea id="remote-node-secrets" value={form.secretRefs} onChange={(event) => update('secretRefs', event.target.value)} placeholder={t(target.secretRefsPlaceholderKey)} />
                  <p className="text-xs text-muted-foreground">{t('remoteFleet.registration.secretRefBoundary')}</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="remote-node-public-config">{t('remoteFleet.registration.fields.publicConfig')}</Label>
                  <Textarea id="remote-node-public-config" value={form.publicConfig} onChange={(event) => update('publicConfig', event.target.value)} placeholder={t(target.publicConfigPlaceholderKey)} />
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
