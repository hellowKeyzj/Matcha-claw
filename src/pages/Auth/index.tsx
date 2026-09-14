import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2, Lock, Mail } from 'lucide-react';
import { AccountOrbitCore } from '@/components/account/AccountOrbitCore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAccountStore } from '@/stores/account';

type AuthMode = 'login' | 'register';

type AuthPageProps = {
  onLocalEntry?: () => void;
};

type AuthPageContentProps = AuthPageProps & {
  forcedMode?: AuthMode;
};

function getAuthMode(pathname: string): AuthMode {
  return pathname.startsWith('/register') ? 'register' : 'login';
}

export function LoginPage(props: AuthPageProps) {
  return <AuthPageContent {...props} forcedMode="login" />;
}

export function RegisterPage(props: AuthPageProps) {
  return <AuthPageContent {...props} forcedMode="register" />;
}

export function AuthPage(props: AuthPageProps) {
  return <AuthPageContent {...props} />;
}

function AuthPageContent({ forcedMode, onLocalEntry }: AuthPageContentProps) {
  const { t } = useTranslation('common');
  const location = useLocation();
  const navigate = useNavigate();
  const init = useAccountStore((state) => state.init);
  const status = useAccountStore((state) => state.status);
  const publicSettings = useAccountStore((state) => state.publicSettings);
  const storeError = useAccountStore((state) => state.errorMessage);
  const clearError = useAccountStore((state) => state.clearError);
  const login = useAccountStore((state) => state.login);
  const login2FA = useAccountStore((state) => state.login2FA);
  const register = useAccountStore((state) => state.register);
  const sendVerifyCode = useAccountStore((state) => state.sendVerifyCode);

  const mode = forcedMode ?? getAuthMode(location.pathname);
  const isRegister = mode === 'register';
  const registrationEnabled = publicSettings?.registrationEnabled !== false;
  const emailVerifyEnabled = publicSettings?.emailVerifyEnabled === true;
  const requires2fa = status === 'requires2fa';
  const loading = status === 'checking';
  const isOffline = status === 'offline';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sendingVerifyCode, setSendingVerifyCode] = useState(false);
  const [verifyCodeCooldown, setVerifyCodeCooldown] = useState(0);
  const [verifyCodeNotice, setVerifyCodeNotice] = useState<string | null>(null);

  const showOfflinePanel = isOffline && !requires2fa;
  const visibleError = formError ?? storeError;
  const title = showOfflinePanel
    ? t('auth.offline.title')
    : requires2fa ? t('auth.title.twoFactor') : isRegister ? t('auth.title.register') : t('auth.title.login');
  const description = showOfflinePanel
    ? t('auth.offline.description')
    : requires2fa
      ? t('auth.description.twoFactor')
      : isRegister
        ? t('auth.description.register')
        : t('auth.description.login');
  const submitLabel = requires2fa ? t('auth.submit.twoFactor') : isRegister ? t('auth.submit.register') : t('auth.submit.login');
  const localEntryAvailable = status === 'signedOut' || status === 'offline';
  const localEntryLabel = status === 'offline' ? t('auth.localEntry.offline') : t('auth.localEntry.guest');
  const localEntryDescription = t('auth.localEntry.guestDescription');

  const canSubmit = useMemo(() => {
    if (loading || submitting || sendingVerifyCode) {
      return false;
    }
    if (requires2fa) {
      return twoFactorCode.trim().length > 0;
    }
    if (isRegister && !registrationEnabled) {
      return false;
    }
    if (!email.trim() || !password) {
      return false;
    }
    if (isRegister && emailVerifyEnabled && !verifyCode.trim()) {
      return false;
    }
    return true;
  }, [email, emailVerifyEnabled, isRegister, loading, password, registrationEnabled, requires2fa, sendingVerifyCode, submitting, twoFactorCode, verifyCode]);

  const canSendVerifyCode = useMemo(() => (
    isRegister
    && emailVerifyEnabled
    && !loading
    && !submitting
    && !sendingVerifyCode
    && verifyCodeCooldown <= 0
    && email.trim().length > 0
  ), [email, emailVerifyEnabled, isRegister, loading, sendingVerifyCode, submitting, verifyCodeCooldown]);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    setFormError(null);
    setVerifyCodeNotice(null);
    setVerifyCodeCooldown(0);
    clearError();
  }, [clearError, mode]);

  useEffect(() => {
    if (verifyCodeCooldown <= 0) return undefined;
    const timer = window.setTimeout(() => {
      setVerifyCodeCooldown((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [verifyCodeCooldown]);

  const handleSendVerifyCode = useCallback(async () => {
    const targetEmail = email.trim();
    setFormError(null);
    setVerifyCodeNotice(null);
    clearError();

    if (!targetEmail) {
      setFormError(t('auth.errors.emailRequiredForCode'));
      return;
    }

    setSendingVerifyCode(true);
    try {
      const result = await sendVerifyCode({ email: targetEmail });
      setVerifyCodeNotice(result.message || t('auth.notice.verifyCodeSent'));
      setVerifyCodeCooldown(Math.max(0, Math.ceil(result.countdown)));
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSendingVerifyCode(false);
    }
  }, [clearError, email, sendVerifyCode, t]);

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    clearError();
    setSubmitting(true);

    try {
      if (requires2fa) {
        await login2FA(twoFactorCode.trim());
      } else if (isRegister) {
        if (!registrationEnabled) {
          setFormError(t('auth.errors.registrationClosed'));
          return;
        }
        await register({
          email: email.trim(),
          password,
          ...(emailVerifyEnabled ? { verifyCode: verifyCode.trim() } : {}),
        });
      } else {
        await login({ email: email.trim(), password });
      }

      const nextStatus = useAccountStore.getState().status;
      if (nextStatus === 'signedIn') {
        navigate('/');
      }
    } finally {
      setSubmitting(false);
    }
  }, [clearError, email, emailVerifyEnabled, isRegister, login, login2FA, navigate, password, register, registrationEnabled, requires2fa, t, twoFactorCode, verifyCode]);

  return (
    <main className="relative min-h-[100dvh] overflow-hidden bg-card text-foreground">
      <div className="pointer-events-none absolute inset-x-10 top-1/2 h-40 -translate-y-1/2 rounded-[var(--radius-panel)] bg-accent/20 blur-3xl dark:bg-accent/10" />
      <div className="pointer-events-none absolute left-[14%] top-1/2 h-72 w-72 -translate-y-1/2 rounded-full bg-ring/5 blur-3xl" />

      <section className="relative flex min-h-[100dvh] items-center px-6 py-10 sm:px-10 lg:px-16">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-12 md:grid-cols-[minmax(0,1fr)_minmax(360px,420px)] md:gap-16 lg:gap-24">
          <AccountGatePreview offline={isOffline} />

          <div className="flex w-full justify-center md:justify-end">
            <div className="w-full max-w-md">
              <div className="mb-8 md:hidden">
                <AccountOrbitCore size="compact" />
                <div className="mt-4 text-xl font-semibold tracking-[-0.02em] text-foreground">Matcha</div>
              </div>

              <div className="mb-8">
                <h2 className="text-3xl font-semibold tracking-[-0.04em] text-foreground">{title}</h2>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{description}</p>
              </div>

              {isRegister && !registrationEnabled ? (
                <div className="mb-5 rounded-[var(--radius-interactive)] border border-border bg-muted px-4 py-3 text-sm leading-6 text-muted-foreground">
                  {t('auth.registrationClosedHint')}
                </div>
              ) : null}

              {visibleError && !showOfflinePanel ? (
                <div className="mb-5 flex gap-3 rounded-[var(--radius-interactive)] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm leading-6 text-foreground">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <span>{visibleError}</span>
                </div>
              ) : null}

              {showOfflinePanel ? (
                <div className="mb-5 rounded-[var(--radius-card)] border border-border bg-background/75 px-4 py-3 text-sm leading-6 text-muted-foreground">
                  {t('auth.offline.hint')}
                </div>
              ) : null}

              {!showOfflinePanel ? (
                <form className="space-y-5" onSubmit={handleSubmit}>
                  {requires2fa ? (
                    <div className="space-y-2">
                      <Label htmlFor="two-factor-code">{t('auth.fields.code')}</Label>
                      <Input
                        autoComplete="one-time-code"
                        autoFocus
                        disabled={loading || submitting}
                        id="two-factor-code"
                        inputMode="numeric"
                        onChange={(event) => setTwoFactorCode(event.target.value)}
                        placeholder={t('auth.placeholders.twoFactorCode')}
                        value={twoFactorCode}
                      />
                    </div>
                  ) : (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="email">{t('auth.fields.email')}</Label>
                        <div className="relative">
                          <Mail className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            autoComplete="email"
                            autoFocus
                            className="pl-11"
                            disabled={loading || submitting}
                            id="email"
                            onChange={(event) => setEmail(event.target.value)}
                            placeholder="you@example.com"
                            type="email"
                            value={email}
                          />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="password">{t('auth.fields.password')}</Label>
                        <div className="relative">
                          <Lock className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            autoComplete={isRegister ? 'new-password' : 'current-password'}
                            className="pl-11"
                            disabled={loading || submitting}
                            id="password"
                            onChange={(event) => setPassword(event.target.value)}
                            placeholder={t('auth.placeholders.password')}
                            type="password"
                            value={password}
                          />
                        </div>
                      </div>

                      {isRegister && emailVerifyEnabled ? (
                        <div className="space-y-2">
                          <Label htmlFor="verify-code">{t('auth.fields.emailCode')}</Label>
                          <div className="flex gap-2">
                            <Input
                              autoComplete="one-time-code"
                              disabled={loading || submitting}
                              id="verify-code"
                              inputMode="numeric"
                              onChange={(event) => setVerifyCode(event.target.value)}
                              placeholder={t('auth.placeholders.emailCode')}
                              value={verifyCode}
                            />
                            <Button
                              className="h-11 shrink-0 px-4"
                              disabled={!canSendVerifyCode}
                              onClick={handleSendVerifyCode}
                              type="button"
                              variant="outline"
                            >
                              {sendingVerifyCode ? <Loader2 className="h-4 w-4 animate-spin" /> : verifyCodeCooldown > 0 ? `${verifyCodeCooldown}s` : t('auth.actions.sendVerifyCode')}
                            </Button>
                          </div>
                          {verifyCodeNotice ? <div className="text-xs text-muted-foreground">{verifyCodeNotice}</div> : null}
                        </div>
                      ) : null}
                    </>
                  )}

                  <Button className="h-11 w-full" disabled={!canSubmit} type="submit">
                    {loading || submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {submitLabel}
                  </Button>
                </form>
              ) : null}

              {!isRegister && !requires2fa && localEntryAvailable ? (
                <div className={showOfflinePanel ? 'space-y-3' : 'mt-3 space-y-2'}>
                  <Button
                    className="h-11 w-full"
                    onClick={() => {
                      onLocalEntry?.();
                      navigate('/', { replace: true, state: { accountEntry: 'local' } });
                    }}
                    type="button"
                    variant={showOfflinePanel ? 'default' : 'outline'}
                  >
                    {localEntryLabel}
                  </Button>
                  {showOfflinePanel ? (
                    <Button className="h-11 w-full" onClick={() => void init()} type="button" variant="outline">
                      {t('auth.offline.retry')}
                    </Button>
                  ) : null}
                  {!showOfflinePanel ? (
                    <p className="text-center text-xs leading-5 text-muted-foreground">
                      {localEntryDescription}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {!requires2fa && !showOfflinePanel ? (
                <div className="mt-6 text-center text-sm text-muted-foreground">
                  {isRegister ? t('auth.switch.hasAccount') : t('auth.switch.noAccount')}{' '}
                  {isRegister ? (
                    <Link className="font-medium text-ring underline-offset-4 hover:text-foreground hover:underline" to="/login">
                      {t('auth.switch.login')}
                    </Link>
                  ) : registrationEnabled ? (
                    <Link className="font-medium text-ring underline-offset-4 hover:text-foreground hover:underline" to="/register">
                      {t('auth.switch.register')}
                    </Link>
                  ) : (
                    <span>{t('auth.switch.registrationClosed')}</span>
                  )}
                </div>
              ) : null}

              {!showOfflinePanel ? (
                <p className="mt-8 text-center text-xs leading-5 text-muted-foreground">
                  {t('auth.legal.prefix')}{' '}
                  <a className="text-foreground underline-offset-4 hover:text-ring hover:underline" href="https://matcha.ai/terms" rel="noreferrer" target="_blank">
                    {t('auth.legal.terms')}
                  </a>{' '}
                  {t('auth.legal.and')}{' '}
                  <a className="text-foreground underline-offset-4 hover:text-ring hover:underline" href="https://matcha.ai/privacy" rel="noreferrer" target="_blank">
                    {t('auth.legal.privacy')}
                  </a>
                  {t('auth.legal.suffix')}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function AccountGatePreview({ offline }: { offline: boolean }) {
  const { t } = useTranslation('common');

  return (
    <div className="relative hidden min-h-[560px] flex-col items-center justify-center md:flex">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_48%,hsl(var(--ring)/0.10),transparent_34%)]" />

      <div className="relative grid place-items-center text-center">
        <AccountOrbitCore size="hero" />
        <div className="mt-10 max-w-sm">
          <h1 className="text-4xl font-semibold leading-tight tracking-[-0.04em] text-foreground">
            {offline ? t('auth.preview.offlineHeading') : t('auth.preview.heading')}
          </h1>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            {offline ? t('auth.preview.offlineCopy') : t('auth.preview.copy')}
          </p>
        </div>
      </div>
    </div>
  );
}

export default AuthPage;
