import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useWorldStore } from '@/stores/world';

const WorldConfirmation = createContext<((message: string) => Promise<boolean>) | null>(null);

function worldBasis() {
  const { world, description } = useWorldStore.getState();
  return JSON.stringify([world, description?.incarnation, description?.revision]);
}

export function WorldConfirmationProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('common');
  const location = useLocation();
  const state = useWorldStore();
  const basis = JSON.stringify([location.key, state.world, state.description?.incarnation, state.description?.revision]);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef<{ basis: string; world: string; resolve(value: boolean): void } | null>(null);
  const currentBasis = useRef(basis);
  currentBasis.current = basis;
  const settle = useCallback((accepted: boolean) => {
    const request = pending.current;
    if (!request) return;
    pending.current = null;
    setMessage(null);
    request.resolve(accepted && request.basis === currentBasis.current && request.world === worldBasis());
  }, []);
  useEffect(() => () => { settle(false); }, [basis, settle]);
  const confirm = useCallback((text: string): Promise<boolean> => {
    if (pending.current || basis !== currentBasis.current) return Promise.resolve(false);
    return new Promise(resolve => {
      pending.current = { basis, world: worldBasis(), resolve };
      setMessage(text);
    });
  }, [basis]);
  return <WorldConfirmation.Provider value={confirm}>
    {children}
    <ConfirmDialog open={message !== null} title={t('actions.confirm')} message={message ?? ''}
      confirmLabel={t('actions.confirm')} cancelLabel={t('actions.cancel')}
      onConfirm={() => settle(true)} onCancel={() => settle(false)} />
  </WorldConfirmation.Provider>;
}

export function useWorldConfirmation() {
  const confirm = useContext(WorldConfirmation);
  if (!confirm) throw new Error('World confirmation requires its provider');
  return confirm;
}
