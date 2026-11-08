import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import type { SkillsConfigApplication } from '@/types/skills-operation-result';

export interface AgentSkillOption {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  selectable?: boolean;
  application?: SkillsConfigApplication;
  saveError?: boolean;
  unavailableReason?: string;
}

export function AgentSkillConfigPanel({
  title,
  headerAccessory,
  skillOptions,
  skillsLoading,
  skillsError,
  savingSkillId,
  selectedSkillIds,
  onToggleSkill,
}: {
  title: string;
  headerAccessory?: ReactNode;
  skillOptions: AgentSkillOption[];
  skillsLoading: boolean;
  skillsError?: string | null;
  savingSkillId: string | null;
  selectedSkillIds: string[];
  onToggleSkill: (skillId: string, checked: boolean) => void;
}) {
  const { t } = useTranslation(['chat', 'common']);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border/40 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-sm font-medium text-foreground">{title}</p>
          {headerAccessory ? <div className="shrink-0">{headerAccessory}</div> : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="min-w-0">
          {skillsLoading ? (
            <p className="text-sm text-muted-foreground">{t('skillConfigDialog.loading')}</p>
          ) : skillsError ? (
            <p role="alert" className="text-sm text-destructive">{t('skillConfigDialog.loadFailed')}</p>
          ) : skillOptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('skillConfigDialog.empty')}</p>
          ) : (
            <div className="min-w-0 divide-y divide-border/35">
              {skillOptions.map((skill) => {
                const checked = selectedSkillIds.includes(skill.id);
                const saving = savingSkillId === skill.id;
                const switchDisabled = savingSkillId !== null || (skill.selectable === false && !checked);
                const sessions = skill.application?.sessions;
                const acknowledged = sessions?.filter((session) => session.status === 'acknowledged').length ?? 0;
                const unconfirmed = (sessions?.length ?? 0) - acknowledged;
                return (
                  <div
                    key={skill.id}
                    aria-busy={saving}
                    className={cn(
                      'flex min-w-0 w-full items-start gap-3 overflow-hidden px-2 py-3 transition-colors',
                      checked
                        ? 'bg-secondary/90'
                        : 'hover:bg-secondary',
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
                          {!skill.selectable && skill.unavailableReason ? (
                            <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                              {skill.unavailableReason}
                            </p>
                          ) : null}
                          {skill.saveError ? (
                            <p role="alert" className="mt-1 text-xs leading-5 text-destructive">{t('skillConfigDialog.saveFailed')}</p>
                          ) : !saving && sessions ? (
                            <div role="status" className="mt-1 text-xs leading-5 text-muted-foreground">
                              <p title={sessions.map((session) => t('skillConfigDialog.sessionStatus', {
                                sessionId: session.sessionId,
                                instanceId: session.instanceId,
                                status: t(`skillConfigDialog.${session.status}`),
                              })).join('\n')}>
                                {t(sessions.length === 0 ? 'skillConfigDialog.savedNextStart'
                                  : unconfirmed > 0 ? 'skillConfigDialog.savedPartial' : 'skillConfigDialog.savedAcknowledged')}
                                {sessions.length > 0 ? ` · ${t('skillConfigDialog.applicationCounts', { acknowledged, unconfirmed })}` : null}
                              </p>
                              <p>{t('skillConfigDialog.policyLimits')}</p>
                            </div>
                          ) : null}
                        </div>
                        <div className="shrink-0 flex items-center gap-2">
                          <span className="flex h-4 w-4 items-center justify-center" role="status">
                            {saving ? (
                              <>
                                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
                                <span className="sr-only">{t('common:status.saving')}</span>
                              </>
                            ) : null}
                          </span>
                          <Switch
                            aria-label={t('skillConfigDialog.toggleSkill', { name: skill.name })}
                            checked={checked}
                            disabled={switchDisabled}
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
