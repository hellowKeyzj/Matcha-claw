import { useId } from 'react';
import type { TeamScriptReviewRule } from '@/types/team-design';
import type { TeamScriptReviewEditorProps } from '@/plugins/teams/pages/team-node-editor-types';

export function TeamScriptReviewEditor({ editable, disabled, labels, rule, onRuleChange }: TeamScriptReviewEditorProps) {
  const id = useId();

  return (
    <section className="space-y-[9px]" aria-labelledby={`${id}-label`}>
      <h3 id={`${id}-label`} className="text-xs font-medium text-foreground">{labels.scriptReviewRule}</h3>
      {editable ? (
        <select
          className="h-[41px] w-full min-w-0 rounded-[9px] border border-[hsl(var(--shell-border))] bg-[hsl(var(--shell-surface))] px-3 py-2.5 text-xs leading-[1.6] text-foreground hover:border-[hsl(var(--shell-border-strong))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[hsl(var(--shell-surface-muted))]"
          value={rule}
          required
          disabled={disabled}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-description`}
          aria-invalid={!rule}
          onChange={(event) => onRuleChange(event.target.value as TeamScriptReviewRule | '')}
        >
          <option value="">{labels.scriptReviewRuleRequired}</option>
          {Object.entries(labels.scriptReviewRules).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      ) : rule ? (
        <p className="text-xs text-foreground">{labels.scriptReviewRules[rule]}</p>
      ) : null}
      <p
        id={`${id}-description`}
        className={`text-[11px] leading-relaxed ${rule ? 'text-muted-foreground' : 'text-destructive'}`}
        role={rule ? undefined : 'alert'}
      >
        {rule ? labels.scriptReviewRuleDescriptions[rule] : labels.scriptReviewRuleRequired}
      </p>
    </section>
  );
}
