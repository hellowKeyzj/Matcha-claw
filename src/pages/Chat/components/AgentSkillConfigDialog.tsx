import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

export interface AgentSkillOption {
  id: string;
  name: string;
  icon?: string;
}

export function AgentSkillConfigDialog({
  open,
  title,
  skillOptions,
  skillsLoading,
  selectedSkillIds,
  submitting,
  onToggleSkill,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  skillOptions: AgentSkillOption[];
  skillsLoading: boolean;
  selectedSkillIds: string[];
  submitting: boolean;
  onToggleSkill: (skillId: string, checked: boolean) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation('chat');
  if (!open) {
    return null;
  }
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <section
        role="dialog"
        aria-label={title}
        className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-xl border bg-background p-5 shadow-xl"
      >
        <header className="flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('common:actions.close')}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </header>
        <div className="mt-4 rounded-lg border bg-muted/20 p-3">
          {skillsLoading ? (
            <p className="text-sm text-muted-foreground">{t('skillConfigDialog.loading')}</p>
          ) : skillOptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('skillConfigDialog.empty')}</p>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {skillOptions.map((skill) => {
                const checked = selectedSkillIds.includes(skill.id);
                const inputId = `chat-agent-skill-${skill.id}`;
                return (
                  <label
                    key={skill.id}
                    htmlFor={inputId}
                    className={cn(
                      'flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm',
                      checked ? 'border-primary bg-primary/5' : 'border-border bg-background',
                    )}
                  >
                    <input
                      id={inputId}
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => onToggleSkill(skill.id, event.target.checked)}
                    />
                    <span aria-hidden>{skill.icon?.trim() || '🧩'}</span>
                    <span className="truncate">{skill.name}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2 border-t pt-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            {t('skillConfigDialog.cancel')}
          </Button>
          <Button type="button" onClick={onSubmit} disabled={submitting}>
            {t('skillConfigDialog.save')}
          </Button>
        </div>
      </section>
    </div>
  );
}
