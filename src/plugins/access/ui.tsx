import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Pause, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import type { AccessUiError } from './client';

export function AccessSheet({ title, onClose, busy, children, className = '' }: { title: string; onClose: () => void; busy?: boolean; children: ReactNode; className?: string }) {
  const { t } = useTranslation('access');
  return <Sheet open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <SheetContent className={`access-sheet sm:max-w-[460px] ${className}`} showCloseButton={false} aria-describedby={undefined}>
      <header className="access-sheet-header">
        <SheetTitle>{title}</SheetTitle>
        <Button type="button" variant="ghost" size="icon" aria-label={t('close')} disabled={busy} onClick={onClose}><X aria-hidden="true" className="h-4 w-4" /></Button>
      </header>
      {children}
    </SheetContent>
  </Sheet>;
}

export function RequestError({ code, onRefresh, busy }: { code: AccessUiError | null; onRefresh?: () => void; busy?: boolean }) {
  const { t } = useTranslation('access');
  if (!code) return null;
  return <div className="access-error" role="alert">
    <p>{t(`errors.${code}`)}</p>
    {onRefresh && <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={busy}>{t('refresh')}</Button>}
  </div>;
}

export function AccessStatus({ state }: { state: 'active' | 'paused' | 'enabled' | 'disabled' }) {
  const { t } = useTranslation('access');
  const active = state === 'active' || state === 'enabled';
  const Icon = active ? Check : Pause;
  return <span className={`access-status ${active ? 'is-active' : ''}`}><Icon aria-hidden="true" />{t(state)}</span>;
}
