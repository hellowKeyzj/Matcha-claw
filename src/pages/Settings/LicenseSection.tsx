import { useEffect, useState } from 'react';
import { Eye, EyeOff, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { clearLicense, fetchStoredLicenseKey, revalidateLicense, validateLicense } from '@/lib/license';
import { useLicenseStore } from '@/stores/license';

export function LicenseSection() {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const snapshot = useLicenseStore((state) => state.snapshot);
  const gateError = useLicenseStore((state) => state.error);
  const refresh = useLicenseStore((state) => state.refresh);
  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [storedKey, setStoredKey] = useState<string | null>(null);
  const [storedKeyError, setStoredKeyError] = useState(false);
  const [pendingAction, setPendingAction] = useState<'validate' | 'revalidate' | 'clear' | null>(null);
  const [mode, setMode] = useState<'view' | 'replace' | 'clear'>('view');
  const [feedback, setFeedback] = useState<{ valid: boolean; messageKey: string; snapshot?: typeof snapshot } | null>(null);
  const busy = pendingAction !== null;

  useEffect(() => {
    let cancelled = false;
    void fetchStoredLicenseKey().then((summary) => {
      if (cancelled) return;
      setStoredKey(summary.masked);
      setStoredKeyError(false);
    }).catch(() => {
      if (cancelled) return;
      setStoredKey(null);
      setStoredKeyError(true);
    });
    return () => { cancelled = true; };
  }, [snapshot]);

  const runAction = async (action: 'validate' | 'revalidate' | 'clear') => {
    if (busy) return;
    if (action === 'validate' && !keyInput.trim()) {
      setFeedback({ valid: false, messageKey: 'license.messages.empty' });
      return;
    }
    setPendingAction(action);
    setFeedback(null);
    try {
      if (action === 'clear') {
        const result = await clearLicense();
        if (!result.success) {
          setFeedback({ valid: false, messageKey: 'license.clearFailed' });
        } else {
          setKeyInput('');
          setShowKey(false);
          setStoredKey(null);
          setFeedback(null);
        }
      } else {
        const result = action === 'validate' ? await validateLicense(keyInput.trim()) : await revalidateLicense();
        setFeedback({ valid: result.valid, messageKey: `license.messages.${result.code}`, snapshot });
        if (result.valid) {
          setKeyInput('');
          setShowKey(false);
          setMode('view');
        }
      }
    } catch {
      setFeedback({ valid: false, messageKey: action === 'clear' ? 'license.clearFailed' : 'license.operationFailed' });
    } finally {
      await refresh();
      if (action === 'clear') setMode('view');
      setPendingAction(null);
    }
  };

  const validation = snapshot?.lastValidation;
  const message = feedback && (feedback.snapshot === undefined || feedback.snapshot === snapshot)
    ? feedback
    : validation ? { valid: validation.valid, messageKey: `license.messages.${validation.code}` } : null;
  const gateState = snapshot?.state ?? (gateError ? 'unavailable' : 'checking');
  const hasLicenseDetails = !!(snapshot?.hasStoredKey || snapshot?.hasUsableCache || gateState === 'granted');
  const showKeyForm = mode === 'replace' || (gateState === 'blocked' && !hasLicenseDetails);
  const errorMessage = message && !message.valid ? message : null;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle>{t('license.title')}</CardTitle>
        <Badge role="status" variant={gateState === 'granted' ? 'success' : 'secondary'}>
          {t(`license.gateState.${gateState}`)}
        </Badge>
      </CardHeader>
      <form onSubmit={(event) => { event.preventDefault(); if (showKeyForm) void runAction('validate'); }} aria-busy={busy}>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-6">
            {showKeyForm ? (
              <Label htmlFor="settings-license-key" className="sm:pt-3">
                {t(mode === 'replace' ? 'license.replaceKey' : 'license.inputLabel')}
              </Label>
            ) : (
              <span className="text-sm font-medium leading-6">{t('license.inputLabel')}</span>
            )}
            <div className="min-w-0 space-y-3">
              {showKeyForm ? (
                <div className="relative">
                  <Input
                    id="settings-license-key"
                    type={showKey ? 'text' : 'password'}
                    value={keyInput}
                    placeholder={t('license.placeholder')}
                    onChange={(event) => { setKeyInput(event.target.value); setFeedback(null); }}
                    disabled={busy}
                    autoFocus={mode === 'replace'}
                    autoComplete="off"
                    spellCheck={false}
                    className="pr-12"
                    aria-describedby={errorMessage ? 'settings-license-error' : undefined}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2"
                    onClick={() => setShowKey((value) => !value)}
                    aria-label={showKey ? t('license.hideKey') : t('license.showKey')}
                    aria-pressed={showKey}
                    disabled={busy}
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              ) : snapshot?.hasStoredKey && storedKey ? (
                <p className="select-text break-all font-mono text-sm leading-6">{storedKey}</p>
              ) : gateState === 'checking' || (snapshot?.hasStoredKey && !storedKeyError) ? (
                <div aria-hidden="true" className="h-6 w-3/4 rounded bg-muted motion-safe:animate-pulse" />
              ) : null}
              {!showKeyForm && hasLicenseDetails && (
                <div className="space-y-1 text-sm text-muted-foreground">
                  {validation?.expiresAt && (
                    <p>{t('license.expiresAt', { time: new Date(validation.expiresAt).toLocaleString(i18n.language) })}</p>
                  )}
                  {validation?.offlineGraceUntilMs != null && (
                    <p>{t('license.offlineGraceUntil', { time: new Date(validation.offlineGraceUntilMs).toLocaleString(i18n.language) })}</p>
                  )}
                </div>
              )}
              {(gateError || storedKeyError) && (
                <div role="alert" className="space-y-1 text-sm text-red-700 dark:text-red-400">
                  {gateError && <p>{t('license.loadFailed')}</p>}
                  {storedKeyError && <p>{t('license.storedKeyFailed')}</p>}
                </div>
              )}
              {snapshot?.renewalAlert && (
                <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
                  {t(`license.renewAlert.${snapshot.renewalAlert}`)}
                </p>
              )}
              {errorMessage && (
                <p id="settings-license-error" role="alert" className="text-sm text-red-700 dark:text-red-400">
                  {t(errorMessage.messageKey, { defaultValue: t('license.messages.unknown') })}
                </p>
              )}
              {showKeyForm && !hasLicenseDetails && (
                <p className="text-sm text-muted-foreground">{t('license.description')}</p>
              )}
            </div>
          </div>
        </CardContent>
        {(showKeyForm || hasLicenseDetails || gateError || storedKeyError) && (
          <CardFooter className="flex-wrap justify-between gap-3 border-t px-6 py-4">
            <div className="flex flex-wrap items-center gap-2">
              {showKeyForm ? (
                <>
                  <Button type="submit" disabled={busy}>
                    {pendingAction === 'validate' && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
                    {t(mode === 'replace' ? 'license.saveAndValidate' : 'license.validate')}
                  </Button>
                  {mode === 'replace' && (
                    <Button type="button" variant="ghost" disabled={busy} onClick={() => {
                      setMode('view');
                      setKeyInput('');
                      setShowKey(false);
                      setFeedback(null);
                    }}>
                      {t('common:actions.cancel')}
                    </Button>
                  )}
                </>
              ) : hasLicenseDetails ? (
                <>
                  <Button type="button" variant="outline" onClick={() => void runAction('revalidate')} disabled={busy || !snapshot?.hasStoredKey}>
                    <RefreshCw className={`h-4 w-4${pendingAction === 'revalidate' ? ' animate-spin motion-reduce:animate-none' : ''}`} />
                    {t('license.revalidate')}
                  </Button>
                  <Button type="button" variant="ghost" disabled={busy} onClick={() => { setMode('replace'); setFeedback(null); }}>
                    {t('license.replaceKey')}
                  </Button>
                </>
              ) : null}
              {(gateError || storedKeyError) && (
                <Button type="button" variant="outline" disabled={busy} onClick={() => void refresh()}>
                  {t('common:actions.refresh')}
                </Button>
              )}
            </div>
            {!showKeyForm && hasLicenseDetails && (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setMode('clear')}>
                {t('license.clear')}
              </Button>
            )}
          </CardFooter>
        )}
      </form>
      <ConfirmDialog
        open={mode === 'clear'}
        title={t('license.clearTitle')}
        message={t('license.clearDescription')}
        confirmLabel={t('license.clear')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onConfirm={() => runAction('clear')}
        onCancel={() => setMode('view')}
      />
    </Card>
  );
}
