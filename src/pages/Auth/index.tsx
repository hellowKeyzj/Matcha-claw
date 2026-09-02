import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, Bot, Cloud, Loader2, Lock, Mail, ShieldCheck, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAccountStore } from '@/stores/account';

type AuthMode = 'login' | 'register';

function getAuthMode(pathname: string): AuthMode {
  return pathname.startsWith('/register') ? 'register' : 'login';
}

export function LoginPage() {
  return <AuthPageContent forcedMode="login" />;
}

export function RegisterPage() {
  return <AuthPageContent forcedMode="register" />;
}

export function AuthPage() {
  return <AuthPageContent />;
}

function AuthPageContent({ forcedMode }: { forcedMode?: AuthMode }) {
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

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sendingVerifyCode, setSendingVerifyCode] = useState(false);
  const [verifyCodeCooldown, setVerifyCodeCooldown] = useState(0);
  const [verifyCodeNotice, setVerifyCodeNotice] = useState<string | null>(null);

  const visibleError = formError ?? storeError;
  const title = requires2fa ? '输入两步验证' : isRegister ? '创建 Matcha 账号' : '登录 Matcha 账号';
  const description = requires2fa
    ? '请输入认证器或邮箱中的验证码。'
    : isRegister
      ? '注册云账号，同步订阅与云端能力。'
      : '登录云账号，管理订阅并同步 Matcha 能力。';
  const submitLabel = requires2fa ? '验证并登录' : isRegister ? '注册' : '登录';

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
      setFormError('请输入邮箱后再获取验证码。');
      return;
    }

    setSendingVerifyCode(true);
    try {
      const result = await sendVerifyCode({ email: targetEmail });
      setVerifyCodeNotice(result.message || '验证码已发送，请查收邮箱。');
      setVerifyCodeCooldown(Math.max(0, Math.ceil(result.countdown)));
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSendingVerifyCode(false);
    }
  }, [clearError, email, sendVerifyCode]);

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
          setFormError('当前暂未开放注册，请直接登录已有账号。');
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
  }, [clearError, email, emailVerifyEnabled, isRegister, login, login2FA, navigate, password, register, registrationEnabled, requires2fa, twoFactorCode, verifyCode]);

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#07090f] text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_16%,rgba(74,222,128,0.26),transparent_26%),radial-gradient(circle_at_82%_22%,rgba(45,212,191,0.18),transparent_28%),linear-gradient(135deg,#07090f_0%,#101827_52%,#07110e_100%)]" />
      <div className="absolute left-1/2 top-1/2 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-400/10 blur-3xl" />

      <section className="relative z-10 flex min-h-screen items-center justify-center px-6 py-10">
        <div className="grid w-full max-w-6xl overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.06] shadow-2xl shadow-black/30 backdrop-blur md:grid-cols-[1.05fr_0.95fr]">
          <div className="relative hidden min-h-[680px] flex-col justify-between overflow-hidden p-10 md:flex">
            <div className="absolute inset-0 bg-[linear-gradient(145deg,rgba(34,197,94,0.16),transparent_38%),radial-gradient(circle_at_72%_72%,rgba(20,184,166,0.20),transparent_32%)]" />
            <div className="relative flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-emerald-300/30 bg-emerald-300/15">
                <Sparkles className="h-5 w-5 text-emerald-200" />
              </div>
              <div>
                <div className="text-lg font-semibold tracking-[-0.02em]">Matcha</div>
                <div className="text-xs text-emerald-100/70">AI workspace account</div>
              </div>
            </div>

            <div className="relative mx-auto flex w-full max-w-md flex-1 items-center">
              <div className="w-full rounded-[2rem] border border-white/12 bg-black/24 p-5 shadow-2xl shadow-emerald-950/30">
                <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.07] p-5">
                  <div className="mb-5 flex items-center justify-between">
                    <div>
                      <div className="text-sm text-white/50">Cloud subscription</div>
                      <div className="text-2xl font-semibold tracking-[-0.04em]">Matcha Pro</div>
                    </div>
                    <Cloud className="h-7 w-7 text-emerald-200" />
                  </div>
                  <div className="grid gap-3">
                    <div className="rounded-2xl border border-emerald-200/20 bg-emerald-200/10 p-4">
                      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-emerald-100">
                        <Bot className="h-4 w-4" />
                        云端能力已就绪
                      </div>
                      <div className="text-xs leading-5 text-white/58">登录后同步订阅、设备与账号状态。</div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-xs text-white/66">
                      <div className="rounded-2xl border border-white/10 bg-white/[0.05] p-4">
                        <div className="mb-1 text-white">安全登录</div>
                        <div>支持两步验证</div>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-white/[0.05] p-4">
                        <div className="mb-1 text-white">订阅同步</div>
                        <div>跨设备管理</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="relative max-w-lg">
              <h1 className="text-4xl font-semibold leading-tight tracking-[-0.05em]">
                一个 Matcha 账号，连接本地工作流与云端订阅。
              </h1>
              <p className="mt-4 text-sm leading-6 text-white/62">
                使用邮箱登录，继续访问账号、订阅和云端能力。
              </p>
            </div>
          </div>

          <div className="flex min-h-[680px] items-center justify-center bg-[#0b0f17]/72 px-6 py-10 sm:px-10">
            <div className="w-full max-w-md">
              <div className="mb-8 md:hidden">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-emerald-300/25 bg-emerald-300/15">
                  <Sparkles className="h-5 w-5 text-emerald-200" />
                </div>
                <div className="text-xl font-semibold">Matcha</div>
              </div>

              <div className="mb-8">
                <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-xs text-emerald-100/80">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Matcha 云账号
                </div>
                <h2 className="text-3xl font-semibold tracking-[-0.05em]">{title}</h2>
                <p className="mt-3 text-sm leading-6 text-white/58">{description}</p>
              </div>

              {isRegister && !registrationEnabled ? (
                <div className="mb-5 rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm leading-6 text-amber-100">
                  当前暂未开放注册，请登录已有 Matcha 账号。
                </div>
              ) : null}

              {visibleError ? (
                <div className="mb-5 flex gap-3 rounded-2xl border border-red-300/20 bg-red-400/10 px-4 py-3 text-sm leading-6 text-red-100">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{visibleError}</span>
                </div>
              ) : null}

              <form className="space-y-5" onSubmit={handleSubmit}>
                {requires2fa ? (
                  <div className="space-y-2">
                    <Label className="text-white/82" htmlFor="two-factor-code">验证码</Label>
                    <Input
                      autoComplete="one-time-code"
                      autoFocus
                      className="border-white/10 bg-white/[0.07] text-white placeholder:text-white/34"
                      disabled={loading || submitting}
                      id="two-factor-code"
                      inputMode="numeric"
                      onChange={(event) => setTwoFactorCode(event.target.value)}
                      placeholder="输入 2FA 验证码"
                      value={twoFactorCode}
                    />
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label className="text-white/82" htmlFor="email">邮箱</Label>
                      <div className="relative">
                        <Mail className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                        <Input
                          autoComplete="email"
                          autoFocus
                          className="border-white/10 bg-white/[0.07] pl-11 text-white placeholder:text-white/34"
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
                      <Label className="text-white/82" htmlFor="password">密码</Label>
                      <div className="relative">
                        <Lock className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                        <Input
                          autoComplete={isRegister ? 'new-password' : 'current-password'}
                          className="border-white/10 bg-white/[0.07] pl-11 text-white placeholder:text-white/34"
                          disabled={loading || submitting}
                          id="password"
                          onChange={(event) => setPassword(event.target.value)}
                          placeholder="输入密码"
                          type="password"
                          value={password}
                        />
                      </div>
                    </div>

                    {isRegister && emailVerifyEnabled ? (
                      <div className="space-y-2">
                        <Label className="text-white/82" htmlFor="verify-code">邮箱验证码</Label>
                        <div className="flex gap-2">
                          <Input
                            autoComplete="one-time-code"
                            className="border-white/10 bg-white/[0.07] text-white placeholder:text-white/34"
                            disabled={loading || submitting}
                            id="verify-code"
                            inputMode="numeric"
                            onChange={(event) => setVerifyCode(event.target.value)}
                            placeholder="输入邮箱验证码"
                            value={verifyCode}
                          />
                          <Button
                            className="h-10 shrink-0 border border-white/10 bg-white/[0.08] px-4 text-white hover:bg-white/[0.13]"
                            disabled={!canSendVerifyCode}
                            onClick={handleSendVerifyCode}
                            type="button"
                          >
                            {sendingVerifyCode ? <Loader2 className="h-4 w-4 animate-spin" /> : verifyCodeCooldown > 0 ? `${verifyCodeCooldown}s` : '获取验证码'}
                          </Button>
                        </div>
                        {verifyCodeNotice ? <div className="text-xs text-emerald-100/72">{verifyCodeNotice}</div> : null}
                      </div>
                    ) : null}
                  </>
                )}

                <Button className="h-11 w-full" disabled={!canSubmit} type="submit">
                  {loading || submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {submitLabel}
                </Button>
              </form>

              {!requires2fa ? (
                <div className="mt-6 text-center text-sm text-white/55">
                  {isRegister ? '已有账号？' : '还没有账号？'}{' '}
                  {isRegister ? (
                    <Link className="font-medium text-emerald-200 hover:text-emerald-100" to="/login">
                      去登录
                    </Link>
                  ) : registrationEnabled ? (
                    <Link className="font-medium text-emerald-200 hover:text-emerald-100" to="/register">
                      创建云账号
                    </Link>
                  ) : (
                    <span className="text-white/35">暂未开放注册</span>
                  )}
                </div>
              ) : null}

              <p className="mt-8 text-center text-xs leading-5 text-white/40">
                继续即表示你同意 Matcha 的{' '}
                <a className="text-white/62 hover:text-white" href="https://matcha.ai/terms" rel="noreferrer" target="_blank">
                  服务条款
                </a>{' '}
                和{' '}
                <a className="text-white/62 hover:text-white" href="https://matcha.ai/privacy" rel="noreferrer" target="_blank">
                  隐私政策
                </a>
                。
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

export default AuthPage;
