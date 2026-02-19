import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { DraftByFile, PreviewDiffByFile, SubagentTargetFile } from '@/types/subagent';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { SubagentDiffPreview } from './SubagentDiffPreview';

interface SubagentManageDialogProps {
  open: boolean;
  agentId: string | null;
  draftPrompt: string;
  generatingDraft: boolean;
  applyingDraft: boolean;
  hasAnyDraft: boolean;
  hasApprovedDraft: boolean;
  applySucceeded: boolean;
  draftByFile: DraftByFile;
  draftError: string | null;
  previewDiffByFile: PreviewDiffByFile;
  persistedContentByFile: Partial<Record<SubagentTargetFile, string>>;
  onDraftPromptChange: (prompt: string) => void;
  onGenerateDraft: () => Promise<void>;
  onGenerateDiffPreview: (originalByFile: Partial<Record<SubagentTargetFile, string>>) => void;
  onApplyDraft: () => Promise<void>;
  onClose: () => void;
}

export function SubagentManageDialog({
  open,
  agentId,
  draftPrompt,
  generatingDraft,
  applyingDraft,
  hasAnyDraft,
  hasApprovedDraft,
  applySucceeded,
  draftByFile,
  draftError,
  previewDiffByFile,
  persistedContentByFile,
  onDraftPromptChange,
  onGenerateDraft,
  onGenerateDiffPreview,
  onApplyDraft,
  onClose,
}: SubagentManageDialogProps) {
  const { t } = useTranslation('subagents');
  if (!open || !agentId) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <section
        role="dialog"
        aria-label={t('manageTitle', { agentId })}
        className="flex max-h-[90vh] w-full max-w-6xl flex-col gap-3 overflow-hidden rounded-lg border bg-background p-4 shadow-lg"
      >
        <header className="flex items-center justify-between">
          <p className="text-sm font-medium">{t('manageTitle', { agentId })}</p>
          <Button variant="ghost" size="icon" aria-label={t('close')} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="space-y-1">
          <Label htmlFor="subagent-draft-prompt">{t('manage.promptLabel')}</Label>
          <Textarea
            id="subagent-draft-prompt"
            value={draftPrompt}
            rows={5}
            placeholder={t('manage.promptPlaceholder')}
            onChange={(event) => onDraftPromptChange(event.target.value)}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!draftPrompt.trim() || generatingDraft || applyingDraft}
            onClick={onGenerateDraft}
          >
            {generatingDraft ? t('manage.generatingDraft') : t('manage.generateDraft')}
          </Button>
          {hasAnyDraft && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const originalByFile = Object.keys(draftByFile).reduce<Partial<Record<SubagentTargetFile, string>>>((acc, fileName) => {
                  acc[fileName as SubagentTargetFile] = persistedContentByFile[fileName as SubagentTargetFile] ?? '';
                  return acc;
                }, {});
                onGenerateDiffPreview(originalByFile);
              }}
            >
              {t('manage.generateDiffPreview')}
            </Button>
          )}
          {hasApprovedDraft && (
            <Button
              size="sm"
              disabled={applyingDraft}
              onClick={onApplyDraft}
            >
              {applyingDraft ? t('manage.applyingDraft') : t('manage.confirmApplyDraft')}
            </Button>
          )}
        </div>

        {applySucceeded && !draftError && (
          <p className="text-xs text-green-600">{t('manage.applyDraftSuccess')}</p>
        )}
        {draftError && (
          <p className="text-xs text-destructive">{draftError}</p>
        )}

        <div className="min-h-0 flex-1 overflow-auto pr-1">
          <SubagentDiffPreview
            previewDiffByFile={previewDiffByFile}
            persistedContentByFile={persistedContentByFile}
          />
        </div>
      </section>
    </div>
  );
}

export default SubagentManageDialog;
