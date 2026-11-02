import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

export function IabConfirmation({ open, title, message, confirmLabel, onConfirm, onCancel, error }: {
  open: boolean; title: string; message: string; confirmLabel: string;
  onConfirm: () => void | Promise<void>; onCancel: () => void; error?: boolean;
}) {
  const { t } = useTranslation('iab');
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const buttons = [...root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []];
      const first = buttons[0]; const last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [open]);
  return open ? createPortal(<div ref={root}>
    <ConfirmDialog open title={title} message={error ? `${message}\n${t('failed')}` : message} confirmLabel={confirmLabel} cancelLabel={t('cancel')}
      variant="destructive" onConfirm={onConfirm} onCancel={onCancel} />
    {error && <span role="alert" className="sr-only">{t('failed')}</span>}
  </div>, document.body) : null;
}
