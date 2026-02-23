import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface TeamDeleteDialogProps {
  open: boolean;
  teamName: string | null;
  confirmValue: string;
  deleting: boolean;
  onConfirmValueChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function TeamDeleteDialog({
  open,
  teamName,
  confirmValue,
  deleting,
  onConfirmValueChange,
  onClose,
  onConfirm,
}: TeamDeleteDialogProps) {
  const { t } = useTranslation('teams');

  if (!open || !teamName) {
    return null;
  }

  const canConfirm = !deleting && confirmValue.trim() === teamName;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <section
        role="dialog"
        aria-label={t('deleteDialog.title')}
        className="w-full max-w-md rounded-lg border bg-background p-4 shadow-lg"
      >
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('deleteDialog.title')}</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('createDialog.close')}
            onClick={onClose}
            disabled={deleting}
          >
            <X className="h-4 w-4" />
          </Button>
        </header>
        <p className="mt-2 text-sm text-muted-foreground">{t('deleteDialog.description')}</p>
        <p className="mt-2 text-sm text-muted-foreground">{t('deleteDialog.scope')}</p>
        <p className="mt-3 text-xs text-muted-foreground">
          {t('deleteDialog.typeToConfirm', { name: teamName })}
        </p>
        <Input
          value={confirmValue}
          onChange={(event) => onConfirmValueChange(event.target.value)}
          placeholder={t('deleteDialog.confirmPlaceholder')}
          className="mt-2"
          disabled={deleting}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose} disabled={deleting}>
            {t('deleteDialog.cancel')}
          </Button>
          <Button
            variant="destructive"
            type="button"
            onClick={() => void onConfirm()}
            disabled={!canConfirm}
          >
            {deleting ? t('deleteDialog.deleting') : t('deleteDialog.confirm')}
          </Button>
        </div>
      </section>
    </div>
  );
}

export default TeamDeleteDialog;
