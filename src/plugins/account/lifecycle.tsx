import { useEffect } from 'react';
import { isTraceEnabled, startupTrace } from '@/lib/trace-logger';
import { useAccountStore } from './stores/account';

export function AccountLifecycle() {
  const initAccount = useAccountStore((state) => state.init);

  useEffect(() => {
    if (!isTraceEnabled()) {
      void initAccount();
      return;
    }
    const startedAt = performance.now();
    startupTrace('renderer.app', 'account.init.start');
    void initAccount().finally(() => startupTrace('renderer.app', 'account.init.end', () => ({
      durationMs: Math.round(performance.now() - startedAt),
      accountStatus: useAccountStore.getState().status,
      outcome: useAccountStore.getState().errorMessage ? 'error' : 'settled',
    })));
    return () => startupTrace('renderer.app', 'account.init.cleanup');
  }, [initAccount]);

  return null;
}
