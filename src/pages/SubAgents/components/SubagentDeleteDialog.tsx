import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface SubagentDeleteDialogProps {
  open: boolean;
  agentId: string | null;
  deleting: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function SubagentDeleteDialog({
  open,
  agentId,
  deleting,
  onConfirm,
  onClose,
}: SubagentDeleteDialogProps) {
  const { t } = useTranslation('subagents');

  if (!open || !agentId) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <section
        role="dialog"
        aria-label={t('deleteDialog.title', { agentId })}
        className="w-full max-w-md rounded-lg border bg-background p-4 shadow-lg"
      >
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('deleteDialog.title', { agentId })}</h2>
          <Button variant="ghost" size="icon" aria-label={t('close')} onClick={onClose} disabled={deleting}>
            <X className="h-4 w-4" />
          </Button>
        </header>
        <p className="mt-2 text-sm text-muted-foreground">{t('deleteDialog.description')}</p>
        <div className="mt-4 flex justify-end">
          <Button variant="destructive" type="button" onClick={() => void onConfirm()} disabled={deleting}>
            {deleting ? t('deleteDialog.deleting') : t('deleteDialog.confirm')}
          </Button>
        </div>
      </section>
    </div>
  );
}

export default SubagentDeleteDialog;
