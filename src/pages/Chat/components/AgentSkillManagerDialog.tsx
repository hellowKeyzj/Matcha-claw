import { useMemo } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getOrBuildMarkdownBody } from '../md-pipeline';
import { AgentSkillConfigPanel, type AgentSkillOption } from './AgentSkillConfigPanel';

export interface AgentSkillPreviewState {
  skillId: string;
  skillName: string;
  markdown: string | null;
  loading: boolean;
  error: string | null;
  filePath?: string;
}

export interface AgentSkillManagerDialogProps {
  label: string;
  title: string;
  skillOptions: AgentSkillOption[];
  skillsLoading: boolean;
  selectedSkillIds: string[];
  skillPreview: AgentSkillPreviewState | null;
  onToggleSkill: (skillId: string, checked: boolean) => void;
  onClearSkillPreview: () => void;
  onClose: () => void;
}

const PANEL_PAD_X = 'px-3';
const PANEL_PAD_Y = 'py-3';

export function AgentSkillManagerDialog({
  label,
  title,
  skillOptions,
  skillsLoading,
  selectedSkillIds,
  skillPreview,
  onToggleSkill,
  onClearSkillPreview,
  onClose,
}: AgentSkillManagerDialogProps) {
  const { t } = useTranslation(['chat', 'common']);
  const previewHtml = useMemo(() => {
    if (!skillPreview?.markdown) {
      return null;
    }
    return getOrBuildMarkdownBody(
      `chat-skill-preview:${skillPreview.skillId}:${skillPreview.filePath ?? ''}:${skillPreview.markdown}`,
      { markdown: skillPreview.markdown },
    ).fullHtml;
  }, [skillPreview]);

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-[hsl(var(--shell-scrim))] p-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="flex h-[min(720px,calc(100vh-3rem))] w-full max-w-[54rem] overflow-hidden rounded-[1.25rem] border bg-[hsl(var(--shell-surface))] shadow-[var(--shell-shadow-overlay)] [border-color:hsl(var(--shell-border))]"
      >
        {skillPreview ? (
          <div data-testid="chat-skill-preview-panel" className="flex min-h-0 flex-1 flex-col">
            <div className={cn('border-b [border-color:hsl(var(--shell-border))]', PANEL_PAD_X, PANEL_PAD_Y)}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 rounded-md"
                    onClick={onClearSkillPreview}
                    aria-label={t('common:actions.back')}
                    title={t('common:actions.back')}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{skillPreview.skillName}</p>
                    <p className="text-xs text-[hsl(var(--shell-text-muted))]">{t('chat:skillPreviewTitle')}</p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 rounded-md"
                  onClick={onClose}
                  aria-label={t('common:actions.close')}
                  title={t('common:actions.close')}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className={cn('min-h-0 flex-1 overflow-y-auto', PANEL_PAD_X, PANEL_PAD_Y)}>
              {skillPreview.loading ? (
                <p className="text-sm text-muted-foreground">{t('chat:skillPreviewLoading')}</p>
              ) : null}
              {!skillPreview.loading && skillPreview.error ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive">
                  {skillPreview.error}
                </div>
              ) : null}
              {!skillPreview.loading && !skillPreview.error && previewHtml ? (
                <div
                  className="prose prose-zinc max-w-none break-words dark:prose-invert prose-headings:mb-2 prose-headings:mt-4 prose-headings:tracking-[-0.02em] prose-p:my-0 prose-p:leading-7 prose-pre:my-3 prose-pre:rounded-[18px] prose-pre:border prose-pre:border-border/45 prose-pre:bg-background/88 prose-pre:px-4 prose-pre:py-3 prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-blockquote:border-l-border/60 prose-blockquote:text-muted-foreground prose-blockquote:italic prose-code:rounded prose-code:bg-background/75 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.92em]"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              ) : null}
            </div>
          </div>
        ) : (
          <AgentSkillConfigPanel
            title={title}
            headerAccessory={(
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-md"
                onClick={onClose}
                aria-label={t('common:actions.close')}
                title={t('common:actions.close')}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
            skillOptions={skillOptions}
            skillsLoading={skillsLoading}
            selectedSkillIds={selectedSkillIds}
            onToggleSkill={onToggleSkill}
          />
        )}
      </section>
    </div>
  );
}
