import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { buildProviderCredentialId } from '../services/provider-accounts';
import { CUSTOM_MEDIA_CONTRACTS, getCustomMediaContract } from '../domain/custom-media-provider-contracts';
import { normalizeProviderApiKeyInput, type ProviderCredential } from '../domain/providers';
import { ProviderMutationError } from '../domain/provider-projection-errors';
import { ProviderCredentialModelsEditor } from '../components/ProviderCredentialModelsEditor';
import { collectDraftModels, modelToDraftRow, type ModelDraftRow } from './provider-model-draft';
import { useContributions } from '@/plugin-host/react';
import { providerAuthMethods, type ProviderAddFormProps, type ProviderEditFormProps, type ProviderOAuthStartRequest, type ProviderSecretInput } from '../extensions';

const CHAT_PROTOCOLS = [
  { id: 'openai-completions', label: 'aiProviders.protocols.openaiCompletions' },
  { id: 'openai-responses', label: 'aiProviders.protocols.openaiResponses' },
  { id: 'anthropic-messages', label: 'aiProviders.protocols.anthropic' },
  { id: 'google-generative-ai', label: 'aiProviders.protocols.google' },
] as const;

export function ProviderAccountAddForm(props: ProviderAddFormProps) {
  return <ProviderAccountForm {...props} mode="add" />;
}

export function StandardProviderEditForm(props: ProviderEditFormProps) {
  return <ProviderAccountForm {...props} mode="edit" />;
}

export function LocalProviderEditForm(props: ProviderEditFormProps) {
  return <ProviderAccountForm {...props} mode="edit" />;
}

export function CustomProviderEditForm(props: ProviderEditFormProps) {
  return <ProviderAccountForm {...props} mode="edit" />;
}

type FormProps = (ProviderAddFormProps & { mode: 'add' }) | (ProviderEditFormProps & { mode: 'edit' });

function ProviderAccountForm(props: FormProps) {
  const { t } = useTranslation('settings');
  const { vendor, accountVendor, onSubmit, onReplaceModels, onSaved, onBusyChange } = props;
  const typeInfo = vendor.info;
  const methods = useContributions(providerAuthMethods).flatMap((contribution) => contribution.methods.map((method) => ({
    ...method,
    flow: contribution.flow,
    component: contribution.flow === 'oauth' ? contribution.component : undefined,
  })));
  const makeAccount = (): ProviderCredential => props.mode === 'edit' ? props.account : {
    id: buildProviderCredentialId(typeInfo.id, null, accountVendor ? [accountVendor] : []),
    vendorId: typeInfo.id,
    label: typeInfo.id === 'custom' ? t('aiProviders.custom') : typeInfo.name,
    providerKind: 'chat',
    authMode: accountVendor?.defaultAuthMode ?? 'api_key',
    baseUrl: typeInfo.defaultBaseUrl,
    apiProtocol: typeInfo.id === 'custom' ? 'openai-completions' : typeInfo.apiProtocol,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const [account, setAccount] = useState(makeAccount);
  const isCloudAccount = account.id === 'matcha-cloud';
  const [savedAccount, setSavedAccount] = useState<ProviderCredential | null>(() => props.mode === 'edit' ? props.account : null);
  const confirmedSecret = useRef('');
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [codePlan, setCodePlan] = useState(() => Boolean(typeInfo.codePlan?.baseUrl && account.baseUrl === typeInfo.codePlan.baseUrl));
  const [rows, setRows] = useState<ModelDraftRow[]>(() => props.models.map(modelToDraftRow));
  const [modelsInitialized, setModelsInitialized] = useState(props.mode === 'add' || props.modelsReady);
  const [saving, setSaving] = useState(false);
  const [phase, setPhase] = useState<'account' | 'models' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState(false);
  const previous = useRef({ vendor: typeInfo.id, selection: props.mode === 'add' ? props.selection : null });
  const completedAccount = props.mode === 'add' ? props.completedAccount : null;

  useEffect(() => {
    if (props.mode !== 'add' || (previous.current.vendor === typeInfo.id && previous.current.selection === props.selection)) return;
    previous.current = { vendor: typeInfo.id, selection: props.selection };
    setAccount(makeAccount());
    setSavedAccount(null);
    setKey('');
    setShowKey(false);
    setCodePlan(false);
    setRows([]);
    setError(null);
    setUnknown(false);
    confirmedSecret.current = '';
    // Selection is the form reset boundary, not projection refresh or translation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeInfo.id, props.mode, props.mode === 'add' ? props.selection : null]);

  useEffect(() => {
    if (modelsInitialized || !props.modelsReady) return;
    setRows(props.models.map(modelToDraftRow));
    setModelsInitialized(true);
  }, [modelsInitialized, props.modelsReady, props.models]);

  useEffect(() => {
    if (!completedAccount) return;
    setAccount(completedAccount);
    setSavedAccount(completedAccount);
    setKey('');
    setError(null);
  }, [completedAccount]);

  const method = methods.find(({ id }) => id === account.authMode);
  const normalizedKey = normalizeProviderApiKeyInput(key);
  const secret: ProviderSecretInput = method?.input === 'token' ? { token: normalizedKey || undefined }
    : method?.input ? { apiKey: normalizedKey || undefined } : {};
  const oauth = props.mode === 'add' ? props.oauth : null;
  const needsOAuth = !savedAccount && method?.flow === 'oauth';
  const OAuthPanel = vendor.oauthPanel ?? method?.component;
  const flowing = oauth?.flowing ?? false;
  const disabled = saving || unknown || flowing || oauth?.outcome === 'unknown' || Boolean(oauth?.outcome === 'confirmed' && !savedAccount);
  const isMedia = account.providerKind === 'media';
  const mediaContract = getCustomMediaContract(account.mediaApiProtocol);
  const effectiveAccount: ProviderCredential = {
    ...account,
    label: account.label.trim(),
    baseUrl: codePlan ? typeInfo.codePlan?.baseUrl : account.baseUrl?.trim() || undefined,
  };
  const patch = (updates: Partial<ProviderCredential>) => {
    setAccount((current) => ({ ...current, ...updates }));
    setError(null);
  };
  const canCreate = () => {
    if (props.mode !== 'add' || savedAccount) return true;
    if (vendor.conflict?.vendors.some((id) => props.existingVendorIds.has(id))) {
      setError(t(vendor.conflict.message));
      return false;
    }
    if (accountVendor?.supportsMultipleAccounts === false && props.existingVendorIds.has(typeInfo.id)) {
      setError(t('aiProviders.toast.duplicateSingleProvider'));
      return false;
    }
    return true;
  };
  const createOAuthRequest = (): ProviderOAuthStartRequest | null => {
    if (!canCreate() || !effectiveAccount.label || (account.authMode !== 'oauth_browser' && account.authMode !== 'oauth_device')) return null;
    return {
      provider: account.vendorId,
      accountId: account.id,
      label: effectiveAccount.label,
      mode: account.authMode,
      baseUrl: effectiveAccount.baseUrl,
      apiProtocol: effectiveAccount.apiProtocol,
    };
  };
  const save = async () => {
    if (disabled || !canCreate()) return;
    setError(null);
    if (!effectiveAccount.label) { setError(t('aiProviders.dialog.nameRequired')); return; }
    if (!savedAccount && method?.input && !normalizedKey) { setError(t('aiProviders.toast.invalidKey')); return; }
    const collected = collectDraftModels(effectiveAccount, rows, accountVendor);
    if ('error' in collected) { setError(t(`providerModels.errors.${collected.error}`, { id: collected.modelId })); return; }
    setSaving(true);
    onBusyChange(true);
    let accountConfirmed = false;
    try {
      setPhase('account');
      const accountFields = (value: ProviderCredential) => JSON.stringify([value.id, value.vendorId, value.label, value.authMode, value.providerKind ?? 'chat', value.baseUrl ?? '', value.apiProtocol, value.mediaApiProtocol, value.enabled]);
      const needsAccountSave = !isCloudAccount && (!savedAccount || accountFields(savedAccount) !== accountFields(effectiveAccount)
        || (normalizedKey && confirmedSecret.current !== normalizedKey)
        || (method?.flow === 'cli-reuse' && !confirmedSecret.current));
      const confirmed = needsAccountSave ? await onSubmit(effectiveAccount, secret, !savedAccount) : savedAccount!;
      setSavedAccount(confirmed);
      props.onAccountLocked();
      confirmedSecret.current = normalizedKey || (method?.flow === 'cli-reuse' ? 'cli-confirmed' : '');
      accountConfirmed = true;
      setPhase('models');
      await onReplaceModels(confirmed.id, collected.models);
      setKey('');
      onSaved();
    } catch (saveError) {
      const uncertain = !(saveError instanceof ProviderMutationError) || saveError.reason === 'unknown';
      setUnknown(uncertain);
      if (uncertain) props.onAccountLocked();
      setError(t(accountConfirmed ? 'aiProviders.dialog.modelsSaveFailed' : uncertain ? 'aiProviders.dialog.saveErrors.unknown' : 'aiProviders.dialog.saveErrors.rejected'));
    } finally {
      setSaving(false);
      setPhase(null);
      onBusyChange(false);
    }
  };

  if (!props.active) return null;

  return (
    <div className="space-y-5">
      {completedAccount ? <p role="status" className="text-sm text-muted-foreground">{t('aiProviders.dialog.authenticatedContinue')}</p> : null}
      {!isCloudAccount ? <fieldset disabled={disabled} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="provider-name">{t('aiProviders.dialog.displayName')}</Label>
          <Input id="provider-name" value={account.label} onChange={(event) => patch({ label: event.target.value })} />
        </div>
        {vendor.form === 'custom' ? (
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="provider-kind">{t('aiProviders.dialog.providerType')}</Label>
            <Select id="provider-kind" value={account.providerKind ?? 'chat'} disabled={Boolean(savedAccount)} onChange={(event) => {
              const media = event.target.value === 'media';
              patch({ providerKind: media ? 'media' : 'chat', mediaApiProtocol: media ? 'openai' : undefined, apiProtocol: media ? undefined : 'openai-completions', baseUrl: media ? getCustomMediaContract('openai')?.defaultBaseUrl : '' });
              setCodePlan(false);
            }}>
              <option value="chat">{t('aiProviders.dialog.chatProvider')}</option>
              <option value="media">{t('aiProviders.dialog.mediaProvider')}</option>
            </Select>
          </div>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="provider-protocol">{t('aiProviders.dialog.protocol')}</Label>
          <Select id="provider-protocol" value={(isMedia ? account.mediaApiProtocol : account.apiProtocol) ?? ''} disabled={!isMedia && Boolean(typeInfo.apiProtocol)} onChange={(event) => {
            if (isMedia) {
              const next = getCustomMediaContract(event.target.value);
              patch({ mediaApiProtocol: event.target.value as ProviderCredential['mediaApiProtocol'], ...(account.baseUrl === mediaContract?.defaultBaseUrl ? { baseUrl: next?.defaultBaseUrl } : {}) });
            } else {
              patch({ apiProtocol: (event.target.value || undefined) as ProviderCredential['apiProtocol'] });
            }
          }}>
            {!isMedia && typeInfo.id !== 'custom' && !typeInfo.apiProtocol ? <option value="">{t('aiProviders.dialog.vendorProtocol')}</option> : null}
            {isMedia ? CUSTOM_MEDIA_CONTRACTS.map((contract) => <option key={contract.id} value={contract.id}>{contract.label}</option>)
              : CHAT_PROTOCOLS.map((protocol) => <option key={protocol.id} value={protocol.id}>{t(protocol.label)}</option>)}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="provider-auth">{t('aiProviders.dialog.authMode')}</Label>
          <Select id="provider-auth" value={account.authMode} disabled={Boolean(savedAccount)} onChange={(event) => { patch({ authMode: event.target.value as ProviderCredential['authMode'] }); setKey(''); }}>
            {(accountVendor?.supportedAuthModes ?? [account.authMode]).map((mode) => <option key={mode} value={mode}>{t(methods.find(({ id }) => id === mode)?.label ?? mode)}</option>)}
          </Select>
        </div>
        {typeInfo.endpointPresets?.length ? (
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="provider-region">{t('aiProviders.dialog.endpointPreset')}</Label>
            <Select id="provider-region" value={account.baseUrl ?? ''} onChange={(event) => patch({ baseUrl: event.target.value })}>
              {!typeInfo.endpointPresets.some((preset) => preset.baseUrl === account.baseUrl) ? <option value={account.baseUrl ?? ''}>{t('aiProviders.custom')}</option> : null}
              {typeInfo.endpointPresets.map((preset) => <option key={preset.id} value={preset.baseUrl}>{preset.label}</option>)}
            </Select>
          </div>
        ) : null}
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="provider-endpoint">{t('aiProviders.dialog.baseUrl')}</Label>
          <Input id="provider-endpoint" type="url" value={codePlan ? typeInfo.codePlan?.baseUrl ?? '' : account.baseUrl ?? ''} disabled={codePlan} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder={mediaContract?.defaultBaseUrl ?? typeInfo.defaultBaseUrl ?? 'https://api.example.com/v1'} />
        </div>
        {typeInfo.codePlan?.baseUrl && !isMedia ? (
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={codePlan} onChange={(event) => setCodePlan(event.target.checked)} />{t('aiProviders.dialog.codePlanMode')}</label>
        ) : null}
        {method?.input ? (
          <div className="space-y-2 sm:col-span-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="provider-secret">{t(method.input === 'token' ? 'aiProviders.authModes.token' : 'aiProviders.dialog.apiKey')}</Label>
              {typeInfo.apiKeyUrl ? <a href={typeInfo.apiKeyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">{t('aiProviders.oauth.getApiKey')}<ExternalLink className="h-3 w-3" /></a> : null}
            </div>
            <div className="relative">
              <Input id="provider-secret" type={showKey ? 'text' : 'password'} value={key} autoComplete="off" spellCheck={false} onChange={(event) => setKey(event.target.value)} placeholder={savedAccount ? t('aiProviders.dialog.keepCredential') : typeInfo.placeholder} className="pr-11" />
              <Button type="button" variant="ghost" size="icon" onClick={() => setShowKey(!showKey)} aria-label={t(showKey ? 'aiProviders.dialog.hideKey' : 'aiProviders.dialog.showKey')} className="absolute right-0 top-0 h-full w-11">{showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</Button>
            </div>
            <p className="text-xs text-muted-foreground">{t(savedAccount ? 'aiProviders.dialog.replaceApiKeyHelp' : method.input === 'token' ? 'aiProviders.dialog.tokenHelp' : 'aiProviders.dialog.apiKeyStored')}</p>
          </div>
        ) : <p className="text-xs text-muted-foreground sm:col-span-2">{t(method?.flow === 'cli-reuse' ? 'aiProviders.dialog.cliReuseHelp' : savedAccount ? 'aiProviders.dialog.authenticated' : 'aiProviders.dialog.noSecretRequired')}</p>}
      </fieldset> : null}
      {needsOAuth && OAuthPanel && oauth ? oauth.renderPanel(OAuthPanel, createOAuthRequest) : null}
      {!modelsInitialized ? <p role="status" className="text-sm text-muted-foreground">{t(props.modelsLoading ? 'aiProviders.dialog.loadingModels' : 'aiProviders.dialog.modelsUnavailable')}</p> : (
        <ProviderCredentialModelsEditor credential={effectiveAccount} vendor={accountVendor} secret={secret} rows={rows} onChange={setRows} disabled={disabled} discoveryDisabled={needsOAuth || (!savedAccount && Boolean(method?.input) && !normalizedKey)} />
      )}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {unknown ? <p role="status" className="text-xs text-muted-foreground">{t('aiProviders.dialog.saveErrors.unknown')}</p> : null}
      <footer className="sticky bottom-0 -mx-1 flex justify-end gap-2 border-t bg-[hsl(var(--shell-surface))] px-1 py-4">
        <Button type="button" variant="outline" disabled={saving} onClick={props.mode === 'add' ? props.onClose : props.onCancel}>{t('aiProviders.dialog.cancel')}</Button>
        <Button type="button" onClick={() => void save()} disabled={disabled || needsOAuth || !modelsInitialized}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {t(phase === 'account' ? 'aiProviders.dialog.savingAccount' : phase === 'models' ? 'aiProviders.dialog.savingModels' : 'aiProviders.dialog.save')}
        </Button>
      </footer>
    </div>
  );
}
