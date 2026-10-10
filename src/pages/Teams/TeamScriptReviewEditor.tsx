import { useId } from 'react';
import type { TeamScriptReviewRule } from '@/types/team-design';
import type { TeamScriptReviewEditorProps } from './team-node-editor-types';

export function TeamScriptReviewEditor({ editable, disabled, labels, rule, onRuleChange }: TeamScriptReviewEditorProps) {
  const id = useId();

  return (
    <section className="space-y-2" aria-labelledby={`${id}-label`}>
      <h3 id={`${id}-label`} className="text-sm font-medium text-foreground">{labels.scriptReviewRule}</h3>
      {editable ? (
        <select
          className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
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
        <p className="text-sm text-foreground">{labels.scriptReviewRules[rule]}</p>
      ) : null}
      <p
        id={`${id}-description`}
        className={`text-sm leading-relaxed ${rule ? 'text-muted-foreground' : 'text-destructive'}`}
        role={rule ? undefined : 'alert'}
      >
        {rule ? labels.scriptReviewRuleDescriptions[rule] : labels.scriptReviewRuleRequired}
      </p>
    </section>
  );
}
