import { useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { buildProviderCredentialId } from '@/plugins/providers/services/provider-accounts';
import { CUSTOM_MEDIA_CONTRACTS, getCustomMediaContract } from '@/plugins/providers/domain/custom-media-provider-contracts';
import {
  normalizeProviderApiKeyInput,
  type ProviderCredential,
  type ProviderTypeInfo,
} from '@/plugins/providers/domain/providers';
import { cn } from '@/lib/utils';
import { useContributions } from '@/plugin-host/react';
import {
  providerAuthMethods,
  type ProviderAddFormProps,
  type ProviderEditFormProps,
  type ProviderEditPayload,
  type ProviderOAuthStartRequest,
  type ProviderSecretInput,
} from '../extensions';

type ProviderFormKind = 'standard' | 'local' | 'custom';

const CUSTOM_CHAT_PROTOCOLS = [
  { id: 'openai-completions', label: 'aiProviders.protocols.openaiCompletions' },
  { id: 'openai-responses', label: 'aiProviders.protocols.openaiResponses' },
  { id: 'anthropic-messages', label: 'aiProviders.protocols.anthropic' },
] as const;

function useProviderAuthMethods() {
  return useContributions(providerAuthMethods).flatMap((contribution) => (
    contribution.methods.map((method) => ({
      ...method,
      flow: contribution.flow,
      component: contribution.flow === 'oauth' ? contribution.component : undefined,
    }))
  ));
}

function getProtocolBaseUrlPlaceholder(apiProtocol: ProviderCredential['apiProtocol']): string {
  return apiProtocol === 'anthropic-messages'
    ? 'https://api.example.com/anthropic'
    : 'https://api.example.com/v1';
}

function stripUserAgentHeader(headers?: Record<string, string>): Record<string, string> | undefined {
  const next = Object.fromEntries(
    Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() !== 'user-agent'),
  );
  return Object.keys(next).length > 0 ? next : undefined;
}

function isCodePlanBaseUrl(info: ProviderTypeInfo, baseUrl: string | undefined): boolean {
  return Boolean(info.codePlan?.baseUrl && baseUrl === info.codePlan.baseUrl);
}

export function StandardProviderEditForm(props: ProviderEditFormProps) {
  return <ProviderEditForm {...props} kind="standard" />;
}

export function LocalProviderEditForm(props: ProviderEditFormProps) {
  return <ProviderEditForm {...props} kind="local" />;
}

export function CustomProviderEditForm(props: ProviderEditFormProps) {
  return <ProviderEditForm {...props} kind="custom" />;
}

export function ProviderAccountAddForm({
  active,
  selection,
  vendor,
  accountVendor,
  existingVendorIds,
  oauth,
  onSubmit,
  onClose,
}: ProviderAddFormProps) {
  const { t } = useTranslation('settings');
  const typeInfo = vendor.info;
  const kind = vendor.form;
  const authMethods = useProviderAuthMethods();
  const [name, setName] = useState(() => typeInfo.id === 'custom' ? t('aiProviders.custom') : typeInfo.name);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(typeInfo.defaultBaseUrl ?? '');
  const [codePlanEnabled, setCodePlanEnabled] = useState(false);
  const [apiProtocol, setApiProtocol] = useState<ProviderCredential['apiProtocol']>(typeInfo.apiProtocol ?? 'openai-completions');
  const [customKind, setCustomKind] = useState<ProviderCredential['providerKind']>('chat');
  const [mediaApiProtocol, setMediaApiProtocol] = useState<ProviderCredential['mediaApiProtocol']>('openai');
  const [authMode, setAuthMode] = useState<ProviderCredential['authMode']>(accountVendor?.defaultAuthMode ?? 'api_key');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const authMethod = authMethods.find(({ id }) => id === authMode);
  const selectedMediaContract = getCustomMediaContract(mediaApiProtocol);
  const isCustomMedia = kind === 'custom' && customKind === 'media';
  const useOAuthFlow = authMethod?.flow === 'oauth';
  const OAuthPanel = vendor.oauthPanel ?? authMethod?.component;
  const effectiveBaseUrl = (codePlanEnabled ? typeInfo.codePlan?.baseUrl : undefined) ?? (baseUrl.trim() || undefined);
  const normalizedApiKey = normalizeProviderApiKeyInput(apiKey);
  const accountLabel = name || (typeInfo.id === 'custom' ? t('aiProviders.custom') : typeInfo.name) || typeInfo.id;
  const previousSelection = useRef<{ active: boolean; vendorId: string; selection: ProviderAddFormProps['selection'] } | null>(null);

  useEffect(() => {
    if (!selectedMediaContract) return;
    setBaseUrl(selectedMediaContract.defaultBaseUrl ?? '');
  }, [mediaApiProtocol, selectedMediaContract]);

  useEffect(() => {
    const previous = previousSelection.current;
    if (previous?.active === active && previous.vendorId === typeInfo.id && previous.selection === selection) return;
    previousSelection.current = { active, vendorId: typeInfo.id, selection };
    if (!active) {
      setValidationError(null);
      setBaseUrl('');
      setCodePlanEnabled(false);
      setApiProtocol('openai-completions');
      setCustomKind('chat');
      return;
    }
    setName(selection === 'brand' && typeInfo.id === 'custom' ? t('aiProviders.custom') : typeInfo.name);
    setBaseUrl(typeInfo.defaultBaseUrl ?? '');
    setCodePlanEnabled(false);
    setApiProtocol(typeInfo.apiProtocol ?? 'openai-completions');
    setAuthMode(accountVendor?.defaultAuthMode ?? 'api_key');
    setApiKey('');
    if (selection === 'brand') {
      setCustomKind('chat');
      setMediaApiProtocol('openai');
    } else {
      setValidationError(null);
    }
  }, [active, selection, typeInfo, accountVendor?.defaultAuthMode, t]);

  const canCreateAccount = () => {
    if (vendor.conflict?.vendors.some((id) => existingVendorIds.has(id))) {
      toast.error(t(vendor.conflict.message));
      return false;
    }
    if (accountVendor?.supportsMultipleAccounts === false && existingVendorIds.has(typeInfo.id)) {
      toast.error(t('aiProviders.toast.duplicateSingleProvider'));
      return false;
    }
    return true;
  };

  const createOAuthRequest = (): ProviderOAuthStartRequest | null => {
    if (!canCreateAccount() || (authMode !== 'oauth_browser' && authMode !== 'oauth_device')) return null;
    return {
      provider: typeInfo.id,
      accountId: buildProviderCredentialId(typeInfo.id, null, accountVendor ? [accountVendor] : []),
      label: accountLabel,
      mode: authMode,
    };
  };

  const handleAdd = async () => {
    if (!canCreateAccount()) return;
    setSaving(true);
    setValidationError(null);
    try {
      const requiresKey = authMethod?.input === 'apiKey' || authMethod?.input === 'token';
      if (requiresKey && !normalizedApiKey) {
        setValidationError(t('aiProviders.toast.invalidKey'));
        return;
      }
      const secret: ProviderSecretInput = authMethod?.input === 'apiKey'
        ? { apiKey: normalizedApiKey }
        : authMethod?.input === 'token' ? { token: normalizedApiKey } : {};
      await onSubmit({
        vendorId: typeInfo.id,
        label: accountLabel,
        baseUrl: effectiveBaseUrl,
        apiProtocol: isCustomMedia ? undefined : typeInfo.apiProtocol ?? (kind !== 'standard' ? apiProtocol : undefined),
        providerKind: isCustomMedia ? 'media' : 'chat',
        mediaApiProtocol: isCustomMedia ? mediaApiProtocol : undefined,
        authMode,
      }, secret);
    } finally {
      setSaving(false);
    }
  };

  if (!active) return null;

  return (
    <>
      <div className="space-y-4">
        {typeInfo.endpointPresets?.length ? (
          <div className="space-y-2">
            <Label htmlFor="provider-endpoint-preset">{t('aiProviders.dialog.endpointPreset')}</Label>
            <Select id="provider-endpoint-preset" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)}>
              {!typeInfo.endpointPresets.some((preset) => preset.baseUrl === baseUrl) ? <option value={baseUrl}>{t('aiProviders.custom')}</option> : null}
              {typeInfo.endpointPresets.map((preset) => <option key={preset.id} value={preset.baseUrl}>{preset.label}</option>)}
            </Select>
          </div>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="name">{t('aiProviders.dialog.displayName')}</Label>
          <Input
            id="name"
            placeholder={typeInfo.id === 'custom' ? t('aiProviders.custom') : typeInfo.name}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        {kind === 'custom' ? (
          <div className="grid grid-cols-2 overflow-hidden rounded-lg border text-sm">
            <button
              type="button"
              onClick={() => {
                setCustomKind('chat');
                setBaseUrl('');
                setCodePlanEnabled(false);
                setApiProtocol('openai-completions');
              }}
              className={cn(
                'px-3 py-2 transition-colors',
                customKind === 'chat' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {t('aiProviders.dialog.chatProvider')}
            </button>
            <button
              type="button"
              onClick={() => {
                setCustomKind('media');
                setBaseUrl(getCustomMediaContract(mediaApiProtocol)?.defaultBaseUrl ?? '');
                setCodePlanEnabled(false);
              }}
              className={cn(
                'px-3 py-2 transition-colors',
                customKind === 'media' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {t('aiProviders.dialog.mediaProvider')}
            </button>
          </div>
        ) : null}

        {accountVendor && accountVendor.supportedAuthModes.length > 1 ? (
          <div className="space-y-2">
            <Label htmlFor="provider-auth-mode">{t('aiProviders.dialog.authMode')}</Label>
            <Select id="provider-auth-mode" value={authMode} disabled={oauth.flowing} onChange={(event) => {
              setAuthMode(event.target.value as ProviderCredential['authMode']);
              setApiKey('');
              setValidationError(null);
            }}>
              {accountVendor.supportedAuthModes.map((mode) => (
                <option key={mode} value={mode}>{t(authMethods.find(({ id }) => id === mode)?.label ?? mode)}</option>
              ))}
            </Select>
          </div>
        ) : null}
        {authMethod?.flow === 'cli-reuse' ? <p className="text-sm text-muted-foreground">{t('aiProviders.dialog.cliReuseHelp')}</p> : null}

        {authMethod?.input ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="apiKey">{authMethod.input === 'token' ? t('aiProviders.authModes.token') : t('aiProviders.dialog.apiKey')}</Label>
              {typeInfo.apiKeyUrl ? (
                <a
                  href={typeInfo.apiKeyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                  tabIndex={-1}
                >
                  {t('aiProviders.oauth.getApiKey')} <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </div>
            <div className="relative">
              <Input
                id="apiKey"
                type={showKey ? 'text' : 'password'}
                placeholder={typeInfo.placeholder}
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setValidationError(null);
                }}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {validationError ? <p className="text-xs text-destructive">{validationError}</p> : null}
            <p className="text-xs text-muted-foreground">{t(authMethod.input === 'token' ? 'aiProviders.dialog.tokenHelp' : 'aiProviders.dialog.apiKeyStored')}</p>
          </div>
        ) : null}

        {typeInfo.codePlan?.baseUrl ? (
          <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
            <span>{t('aiProviders.dialog.codePlanMode')}</span>
            <input
              type="checkbox"
              checked={codePlanEnabled}
              onChange={(event) => {
                setCodePlanEnabled(event.target.checked);
                setValidationError(null);
              }}
            />
          </label>
        ) : null}

        {isCustomMedia ? (
          <div className="grid gap-3 sm:grid-cols-1">
            <div className="space-y-2">
              <Label htmlFor="provider-add-media-provider">{t('aiProviders.dialog.mediaContract')}</Label>
              <Select
                id="provider-add-media-provider"
                value={mediaApiProtocol}
                onChange={(event) => setMediaApiProtocol(event.target.value as ProviderCredential['mediaApiProtocol'])}
              >
                {CUSTOM_MEDIA_CONTRACTS.map((contract) => (
                  <option key={contract.id} value={contract.id}>{contract.label}</option>
                ))}
              </Select>
            </div>
          </div>
        ) : null}

        {typeInfo.showBaseUrl || isCustomMedia ? (
          <div className="space-y-2">
            <Label htmlFor="baseUrl">{t('aiProviders.dialog.baseUrl')}</Label>
            <Input
              id="baseUrl"
              placeholder={isCustomMedia ? selectedMediaContract?.defaultBaseUrl || 'https://api.example.com/v1' : getProtocolBaseUrlPlaceholder(apiProtocol)}
              value={codePlanEnabled ? typeInfo.codePlan?.baseUrl ?? '' : baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              disabled={codePlanEnabled}
            />
          </div>
        ) : null}

        {kind === 'custom' && !isCustomMedia ? (
          <div className="space-y-2">
            <Label htmlFor="provider-add-protocol">{t('aiProviders.dialog.protocol')}</Label>
            <Select
              id="provider-add-protocol"
              value={apiProtocol}
              onChange={(event) => setApiProtocol(event.target.value as ProviderCredential['apiProtocol'])}
            >
              {CUSTOM_CHAT_PROTOCOLS.map((protocol) => <option key={protocol.id} value={protocol.id}>{t(protocol.label)}</option>)}
            </Select>
          </div>
        ) : null}

        {useOAuthFlow && OAuthPanel ? oauth.renderPanel(OAuthPanel, createOAuthRequest) : null}
      </div>

      <Separator />

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>{t('aiProviders.dialog.cancel')}</Button>
        <Button onClick={handleAdd} className={cn(useOAuthFlow && 'hidden')} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          {t('aiProviders.dialog.add')}
        </Button>
      </div>
    </>
  );
}

function ProviderEditForm({
  active,
  account,
  vendor,
  status,
  onSubmit,
  onCancel,
  kind,
}: ProviderEditFormProps & { kind: ProviderFormKind }) {
  const { t } = useTranslation('settings');
  const typeInfo = vendor.info;
  const authMethod = useProviderAuthMethods().find(({ id }) => id === account.authMode);
  const authLabel = authMethod ? t(authMethod.label) : account.authMode;
  const usesStoredCredential = authMethod?.input === 'apiKey' || authMethod?.input === 'token';
  const [newKey, setNewKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(account.baseUrl || '');
  const [codePlanEnabled, setCodePlanEnabled] = useState(() => isCodePlanBaseUrl(typeInfo, account.baseUrl));
  const [apiProtocol, setApiProtocol] = useState<ProviderCredential['apiProtocol']>(account.apiProtocol || 'openai-completions');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const sanitizedHeaders = stripUserAgentHeader(account.headers);
  const hasLegacyUserAgentHeader = Object.keys(account.headers ?? {}).length !== Object.keys(sanitizedHeaders ?? {}).length;
  const normalizedNewKey = normalizeProviderApiKeyInput(newKey);
  const isMediaCredential = kind === 'custom' && account.providerKind === 'media';
  const editableProtocol = kind !== 'standard';
  const canEditRuntimeConfig = !isMediaCredential && (typeInfo.showBaseUrl || editableProtocol);
  const effectiveBaseUrl = (codePlanEnabled ? typeInfo.codePlan?.baseUrl : undefined) ?? (baseUrl.trim() || undefined);
  const hasConfigChanges = (typeInfo.showBaseUrl && effectiveBaseUrl !== (account.baseUrl || undefined))
    || (!isMediaCredential && editableProtocol && (apiProtocol || 'openai-completions') !== (account.apiProtocol || 'openai-completions'))
    || (!isMediaCredential && Boolean(typeInfo.apiProtocol && typeInfo.apiProtocol !== account.apiProtocol))
    || hasLegacyUserAgentHeader;

  useEffect(() => {
    if (!active) return;
    setNewKey('');
    setShowKey(false);
    setBaseUrl(account.baseUrl || '');
    setCodePlanEnabled(isCodePlanBaseUrl(typeInfo, account.baseUrl));
    setApiProtocol(account.apiProtocol || 'openai-completions');
  }, [active, account.apiProtocol, account.baseUrl, typeInfo]);

  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, onCancel]);

  const handleSaveEdits = async () => {
    setSaving(true);
    try {
      const payload: ProviderEditPayload = {};
      if (normalizedNewKey) {
        if (authMethod?.input === 'token') payload.token = normalizedNewKey;
        else if (authMethod?.input === 'apiKey') payload.newApiKey = normalizedNewKey;
      }
      const updates: Partial<ProviderCredential> = {};
      if (typeInfo.showBaseUrl && effectiveBaseUrl !== (account.baseUrl || undefined)) {
        updates.baseUrl = effectiveBaseUrl;
      }
      if (!isMediaCredential && editableProtocol && (apiProtocol || 'openai-completions') !== (account.apiProtocol || 'openai-completions')) {
        updates.apiProtocol = apiProtocol || 'openai-completions';
      }
      if (!isMediaCredential && typeInfo.apiProtocol && typeInfo.apiProtocol !== account.apiProtocol) {
        updates.apiProtocol = typeInfo.apiProtocol;
      }
      if (hasLegacyUserAgentHeader) {
        updates.headers = sanitizedHeaders;
      }
      if (Object.keys(updates).length > 0) {
        payload.updates = updates;
      }
      if (!payload.newApiKey && !payload.token && !payload.updates && authMethod?.flow !== 'cli-reuse') {
        onCancel();
        return;
      }
      await onSubmit(payload);
      setNewKey('');
      toast.success(t('aiProviders.toast.updated'));
    } catch (saveError) {
      toast.error(`${t('aiProviders.toast.failedUpdate')}: ${saveError}`);
    } finally {
      setSaving(false);
    }
  };

  if (!active) return null;

  return (
    <div className="space-y-3">
      {canEditRuntimeConfig ? (
        <div className="space-y-3 rounded-lg border border-border/80 bg-muted/20 p-3">
          <p className="text-sm font-medium">{t('aiProviders.sections.credentials')}</p>
          {typeInfo.codePlan?.baseUrl ? (
            <label className="flex items-center justify-between gap-3 rounded-md bg-background px-3 py-2 text-sm">
              <span>{t('aiProviders.dialog.codePlanMode')}</span>
              <input
                type="checkbox"
                checked={codePlanEnabled}
                onChange={(event) => setCodePlanEnabled(event.target.checked)}
              />
            </label>
          ) : null}
          {typeInfo.endpointPresets?.length ? (
            <div className="space-y-1">
              <Label htmlFor={`provider-edit-endpoint-${account.id}`} className="text-xs">{t('aiProviders.dialog.endpointPreset')}</Label>
              <Select id={`provider-edit-endpoint-${account.id}`} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)}>
                {!typeInfo.endpointPresets.some((preset) => preset.baseUrl === baseUrl) ? <option value={baseUrl}>{t('aiProviders.custom')}</option> : null}
                {typeInfo.endpointPresets.map((preset) => <option key={preset.id} value={preset.baseUrl}>{preset.label}</option>)}
              </Select>
            </div>
          ) : null}
          {typeInfo.showBaseUrl ? (
            <div className="space-y-1">
              <Label htmlFor={`provider-edit-base-url-${account.id}`} className="text-xs">{t('aiProviders.dialog.baseUrl')}</Label>
              <Input
                id={`provider-edit-base-url-${account.id}`}
                value={codePlanEnabled ? typeInfo.codePlan?.baseUrl ?? '' : baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={getProtocolBaseUrlPlaceholder(apiProtocol)}
                disabled={codePlanEnabled}
                className="h-9 text-sm"
              />
            </div>
          ) : null}
          {kind === 'custom' && !isMediaCredential ? (
            <div className="space-y-1">
              <Label htmlFor={`provider-edit-protocol-${account.id}`} className="text-xs">{t('aiProviders.dialog.protocol')}</Label>
              <Select
                id={`provider-edit-protocol-${account.id}`}
                value={apiProtocol}
                onChange={(event) => setApiProtocol(event.target.value as ProviderCredential['apiProtocol'])}
                className="h-9 text-sm"
              >
                {CUSTOM_CHAT_PROTOCOLS.map((protocol) => <option key={protocol.id} value={protocol.id}>{t(protocol.label)}</option>)}
              </Select>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-3 rounded-lg border border-border/80 bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <Label className="text-xs">{authLabel}</Label>
            <p className="text-xs text-muted-foreground">
              {!usesStoredCredential ? authLabel
                : !status ? t('aiProviders.card.credentialUnknown')
                  : status.hasKey ? t('aiProviders.dialog.apiKeyConfigured') : t('aiProviders.dialog.apiKeyMissing')}
            </p>
          </div>
          {status?.hasKey ? <Badge variant="secondary">{t('aiProviders.card.configured')}</Badge> : null}
        </div>
        {typeInfo.apiKeyUrl ? (
          <a
            href={typeInfo.apiKeyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-primary hover:underline"
            tabIndex={-1}
          >
            {t('aiProviders.oauth.getApiKey')} <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
        {!authMethod?.input ? (
          <div className="space-y-2">
            {authMethod?.flow === 'cli-reuse' ? <p className="text-xs text-muted-foreground">{t('aiProviders.dialog.cliReuseHelp')}</p> : null}
            <Button data-testid={`provider-edit-save-${account.id}`} size="sm" onClick={handleSaveEdits} disabled={saving || (authMethod?.flow !== 'cli-reuse' && !hasConfigChanges)}>
              {saving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              {t('aiProviders.dialog.save')}
            </Button>
          </div>
        ) : (
          <div className="space-y-1">
            <Label className="text-xs">{authMethod?.input === 'token' ? t('aiProviders.dialog.replaceToken') : t('aiProviders.dialog.replaceApiKey')}</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  data-testid={`provider-edit-key-input-${account.id}`}
                  type={showKey ? 'text' : 'password'}
                  placeholder={typeInfo.requiresApiKey ? typeInfo.placeholder : t('aiProviders.card.editKey')}
                  value={newKey}
                  onChange={(event) => setNewKey(event.target.value)}
                  className="h-9 pr-10 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
              <Button
                data-testid={`provider-edit-save-${account.id}`}
                variant="outline"
                size="sm"
                onClick={handleSaveEdits}
                disabled={saving || (!normalizedNewKey && !hasConfigChanges)}
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('aiProviders.dialog.replaceApiKeyHelp')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
