import { Suspense, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { lazyWithPreload } from '@/plugin-host/core';
import { AccountOrbitCore } from './components/AccountOrbitCore';

const AuthRoute = lazyWithPreload(() => import('./pages/Auth'));

export function AccountBootSplash() {
  const { t } = useTranslation('common');

  return (
    <main className="relative grid min-h-[100dvh] place-items-center overflow-hidden bg-card px-6 text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_46%,hsl(var(--ring)/0.10),transparent_34%)]" />
      <section className="relative grid place-items-center text-center" role="status" aria-live="polite">
        <div className="mb-7 text-2xl font-semibold tracking-[-0.04em] text-foreground">Matcha</div>
        <AccountOrbitCore size="boot" />
        <h1 className="mt-8 text-xl font-semibold tracking-[-0.03em] text-foreground">{t('auth.boot.title')}</h1>
      </section>
    </main>
  );
}

export function AuthPage(props: ComponentProps<typeof AuthRoute>) {
  return (
    <Suspense fallback={<AccountBootSplash />}>
      <AuthRoute {...props} />
    </Suspense>
  );
}
