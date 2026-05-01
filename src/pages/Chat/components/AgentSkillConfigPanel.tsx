import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

export interface AgentSkillOption {
  id: string;
  name: string;
  description?: string;
  icon?: string;
}

export function AgentSkillConfigPanel({
  title,
  skillOptions,
  skillsLoading,
  selectedSkillIds,
  onToggleSkill,
}: {
  title: string;
  skillOptions: AgentSkillOption[];
  skillsLoading: boolean;
  selectedSkillIds: string[];
  onToggleSkill: (skillId: string, checked: boolean) => void;
}) {
  const { t } = useTranslation('chat');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border/40 px-4 py-3">
        <p className="text-sm font-medium text-foreground">{title}</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-3">
          {skillsLoading ? (
            <p className="text-sm text-muted-foreground">{t('skillConfigDialog.loading')}</p>
          ) : skillOptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('skillConfigDialog.empty')}</p>
          ) : (
            <div className="grid gap-2">
              {skillOptions.map((skill) => {
                const checked = selectedSkillIds.includes(skill.id);
                return (
                  <div
                    key={skill.id}
                    className={cn(
                      'flex items-start gap-3 rounded-xl border px-3 py-3 transition-colors',
                      checked
                        ? 'border-emerald-500/35 bg-emerald-500/5'
                        : 'border-border/60 bg-background hover:bg-muted/30',
                    )}
                  >
                    <div className={cn(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border text-base',
                      checked
                        ? 'border-emerald-500/30 bg-emerald-500/10'
                        : 'border-border/60 bg-muted/25',
                    )}
                    >
                      <span aria-hidden>{skill.icon?.trim() || '🧩'}</span>
                    </div>

                    <div className="min-w-0 flex-1 pt-0.5">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-foreground">{skill.name}</p>
                          {skill.description ? (
                            <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                              {skill.description}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex items-center">
                          <Switch
                            aria-label={skill.name}
                            checked={checked}
                            onCheckedChange={(nextChecked) => onToggleSkill(skill.id, nextChecked)}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
