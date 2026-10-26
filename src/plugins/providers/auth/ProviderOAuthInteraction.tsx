import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, Loader2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { invokeIpc } from '@/lib/api-client';
import { subscribeHostEvent } from '@/lib/host-events';
import {
  hostProviderCancelOAuth,
  hostProviderStartOAuth,
  hostProviderSubmitOAuthCode,
} from '@/lib/provider-projection';
import { useProviderStore } from '../stores/providers';
import type { ProviderOAuthOwnerProps, ProviderOAuthPanelProps, ProviderOAuthStartRequest } from '../extensions';

type OAuthData = ProviderOAuthPanelProps['oauthData'];

type PendingOAuth = {
  flowId: string;
  accountId: string;
  vendorId: string;
  label: string;
};

export function ProviderOAuthOwner({ onCompleted, children }: ProviderOAuthOwnerProps) {
  const { t } = useTranslation('settings');
  const [oauthFlowing, setOauthFlowing] = useState(false);
  const [oauthData, setOauthData] = useState<OAuthData>(null);
  const [manualCodeInput, setManualCodeInput] = useState('');
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [pendingOAuth, setPendingOAuth] = useState<PendingOAuth | null>(null);
  const latestRef = useRef({ onCompleted, t });

  useEffect(() => {
    latestRef.current = { onCompleted, t };
  });

  useEffect(() => {
    const handleCode = (data: unknown) => {
      const payload = data as Record<string, unknown>;
      if (payload?.mode === 'manual') {
        setOauthData({
          mode: 'manual',
          authorizationUrl: String(payload.authorizationUrl || ''),
          message: typeof payload.message === 'string' ? payload.message : undefined,
        });
      } else {
        setOauthData({
          mode: 'device',
          verificationUri: String(payload.verificationUri || ''),
          userCode: String(payload.userCode || ''),
          expiresIn: Number(payload.expiresIn || 300),
        });
      }
      setOauthError(null);
    };

    const handleSuccess = async () => {
      setOauthFlowing(false);
      setOauthData(null);
      setManualCodeInput('');
      try {
        await useProviderStore.getState().refreshProviderSnapshot({
          trigger: 'reconcile',
          reason: 'oauth_success_reconcile',
        });
      } catch (refreshError) {
        console.error('Failed to refresh providers after OAuth:', refreshError);
      }
      setPendingOAuth(null);
      latestRef.current.onCompleted();
    };

    const handleError = (data: unknown) => {
      setOauthError((data as { message: string }).message);
      setOauthData(null);
      setPendingOAuth(null);
    };

    const offCode = subscribeHostEvent('oauth:code', handleCode);
    const offSuccess = subscribeHostEvent('oauth:success', handleSuccess);
    const offError = subscribeHostEvent('oauth:error', handleError);
    return () => {
      offCode();
      offSuccess();
      offError();
    };
  }, [latestRef]);

  const handleStartOAuth = useCallback(async (createRequest: () => ProviderOAuthStartRequest | null) => {
    const request = createRequest();
    if (!request) return;

    setOauthFlowing(true);
    setOauthData(null);
    setManualCodeInput('');
    setOauthError(null);

    try {
      const flowId = `${request.accountId}:${Date.now().toString(36)}`;
      setPendingOAuth({ flowId, accountId: request.accountId, vendorId: request.provider, label: request.label });
      await hostProviderStartOAuth({ ...request, flowId });
    } catch (oauthStartError) {
      setOauthError(String(oauthStartError));
      setOauthFlowing(false);
      setPendingOAuth(null);
    }
  }, []);

  const handleCancelOAuth = async () => {
    const binding = pendingOAuth;
    setOauthFlowing(false);
    setOauthData(null);
    setManualCodeInput('');
    setOauthError(null);
    setPendingOAuth(null);
    if (binding) {
      await hostProviderCancelOAuth({
        flowId: binding.flowId,
        accountId: binding.accountId,
        vendorId: binding.vendorId,
      });
    }
  };

  const handleSubmitManualOAuthCode = async () => {
    const value = manualCodeInput.trim();
    if (!value || !pendingOAuth) return;
    try {
      await hostProviderSubmitOAuthCode({
        flowId: pendingOAuth.flowId,
        accountId: pendingOAuth.accountId,
        vendorId: pendingOAuth.vendorId,
        code: value,
      });
      setOauthError(null);
    } catch (submitError) {
      setOauthError(String(submitError));
    }
  };

  return children({
    flowing: oauthFlowing,
    renderPanel: (Panel, createRequest) => (
      <Panel
        oauthFlowing={oauthFlowing}
        oauthData={oauthData}
        oauthError={oauthError}
        manualCodeInput={manualCodeInput}
        pendingOAuth={pendingOAuth ? { label: pendingOAuth.label } : null}
        onStart={() => handleStartOAuth(createRequest)}
        onCancel={handleCancelOAuth}
        onManualCodeChange={setManualCodeInput}
        onSubmitManualCode={handleSubmitManualOAuthCode}
      />
    ),
  });
}

export function OAuthPanel(props: ProviderOAuthPanelProps) {
  const { t } = useTranslation('settings');
  const {
    oauthFlowing,
    oauthData,
    oauthError,
    manualCodeInput,
    pendingOAuth,
    onStart,
    onCancel,
    onManualCodeChange,
    onSubmitManualCode,
  } = props;

  return (
    <div className="space-y-4 pt-2">
      <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-4 text-center">
        <p className="mb-3 block text-sm text-blue-200">
          {pendingOAuth ? pendingOAuth.label : t('aiProviders.oauth.loginPrompt')}
        </p>
        <Button onClick={onStart} disabled={oauthFlowing} className="w-full bg-blue-600 text-white hover:bg-blue-700">
          {oauthFlowing ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              {t('aiProviders.oauth.waiting')}
            </>
          ) : (
            t('aiProviders.oauth.loginButton')
          )}
        </Button>
      </div>

      {oauthFlowing || oauthError ? (
        <div className="relative mt-4 overflow-hidden rounded-xl border bg-card p-4">
          <div className="absolute inset-0 bg-primary/5 animate-pulse" />
          <div className="relative z-10 flex flex-col items-center justify-center space-y-4 text-center">
            {oauthError ? (
              <div className="space-y-2 text-red-400">
                <XCircle className="mx-auto h-8 w-8" />
                <p className="font-medium">{t('aiProviders.oauth.authFailed')}</p>
                <p className="text-sm opacity-80">{oauthError}</p>
                <Button variant="outline" size="sm" onClick={onCancel} className="mt-2 text-foreground">
                  {t('aiProviders.oauth.tryAgain')}
                </Button>
              </div>
            ) : !oauthData ? (
              <div className="space-y-3 py-4">
                <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
                <p className="animate-pulse text-sm text-muted-foreground">{t('aiProviders.oauth.requestingCode')}</p>
              </div>
            ) : oauthData.mode === 'manual' ? (
              <div className="w-full space-y-4">
                <div className="space-y-2 text-left">
                  <h3 className="text-lg font-medium text-foreground">{t('aiProviders.oauth.completeLogin')}</h3>
                  <p className="text-sm text-muted-foreground">
                    {oauthData.message || t('aiProviders.oauth.manualHelp')}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => invokeIpc('shell:openExternal', oauthData.authorizationUrl)}
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  {t('aiProviders.oauth.openLoginPage')}
                </Button>
                <Input
                  placeholder={t('aiProviders.oauth.callbackPlaceholder')}
                  value={manualCodeInput}
                  onChange={(event) => onManualCodeChange(event.target.value)}
                />
                <Button className="w-full" onClick={onSubmitManualCode} disabled={!manualCodeInput.trim()}>
                  {t('aiProviders.oauth.submitCode')}
                </Button>
                <Button variant="ghost" size="sm" className="w-full mt-2" onClick={onCancel}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="w-full space-y-4">
                <div className="space-y-1">
                  <h3 className="text-lg font-medium text-foreground">{t('aiProviders.oauth.approveLogin')}</h3>
                  <div className="mt-2 space-y-1 text-left text-sm text-muted-foreground">
                    <p>1. {t('aiProviders.oauth.step1')}</p>
                    <p>2. {t('aiProviders.oauth.step2')}</p>
                    <p>3. {t('aiProviders.oauth.step3')}</p>
                  </div>
                </div>
                <div className="flex items-center justify-center gap-2 rounded-lg border bg-background p-3">
                  <code className="font-mono text-2xl font-bold tracking-widest text-primary">{oauthData.userCode}</code>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      navigator.clipboard.writeText(oauthData.userCode);
                      toast.success(t('aiProviders.oauth.codeCopied'));
                    }}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => invokeIpc('shell:openExternal', oauthData.verificationUri)}
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  {t('aiProviders.oauth.openLoginPage')}
                </Button>
                <div className="flex items-center justify-center gap-2 pt-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>{t('aiProviders.oauth.waitingApproval')}</span>
                </div>
                <Button variant="ghost" size="sm" className="w-full mt-2" onClick={onCancel}>
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
