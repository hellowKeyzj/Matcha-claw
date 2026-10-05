import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

interface TeamDesignDialogProps {
  summary: string;
  detail?: string;
  busy: boolean;
  error?: string;
  onConfirm: () => void;
  onReturnDiscussion: () => void;
  onContinueDesign: () => void;
}

export function TeamDesignDialog({ summary, detail, busy, error, onConfirm, onReturnDiscussion, onContinueDesign }: TeamDesignDialogProps) {
  const { t } = useTranslation('teams');
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[120] bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[121] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-6 shadow-lg"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <Dialog.Title className="text-lg font-semibold">{t('design.readyTitle')}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">{t('design.readyDescription')}</Dialog.Description>
          <p className="mt-4 whitespace-pre-wrap text-sm leading-6">{summary || t('run.proposalPending.emptySummary')}</p>
          {detail ? <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{detail}</p> : null}
          {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={onContinueDesign}>{t('design.adjust')}</Button>
            <Button type="button" variant="outline" disabled={busy} onClick={onReturnDiscussion}>{t('design.discuss')}</Button>
            <Button type="button" disabled={busy} onClick={onConfirm}>{t('design.confirm')}</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
