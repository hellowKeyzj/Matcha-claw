import { useId, useState } from 'react';
import { Bot, Maximize2, Minimize2 } from 'lucide-react';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import type { TeamAssignmentEditorProps } from './team-node-editor-types';

export function TeamAssignmentEditor({
  kind,
  editable,
  disabled,
  labels,
  roleId,
  sessionRef,
  roles,
  prompt,
  outputArtifactKind,
  onBindingChange,
  onPromptChange,
  onOutputArtifactKindChange,
}: TeamAssignmentEditorProps) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const roleIds = [...new Set(roles.map((role) => role.roleId))];
  const sessions = roles.filter((role) => role.roleId === roleId);
  const roleValid = roleIds.includes(roleId);
  const binding = sessions.find((role) => role.sessionRef === sessionRef);
  const showSessions = sessions.length > 1 || !binding;
  const memberLabel = kind === 'review' ? labels.reviewMember : labels.workMember;
  const promptLabel = kind === 'review' ? labels.reviewPrompt : labels.workPrompt;
  const fieldClassName = 'w-full min-w-0 rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

  return (
    <div className="space-y-5">
      <section className="space-y-2" aria-label={memberLabel}>
        <label htmlFor={`${id}-role`} className="text-xs font-medium text-muted-foreground">{memberLabel}</label>
        <div className="flex items-center gap-3">
          {binding ? (
            <AgentAvatar agentId={binding.agentId} alt="" className="h-10 w-10" />
          ) : (
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground" aria-hidden="true">
              <Bot className="h-5 w-5" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <select
              id={`${id}-role`}
              className={fieldClassName}
              value={roleId}
              aria-invalid={!roleValid}
              aria-describedby={!binding ? `${id}-binding-hint` : undefined}
              disabled={!editable || disabled || roleIds.length === 0}
              onChange={(event) => {
                const nextRoleId = event.target.value;
                const candidates = roles.filter((role) => role.roleId === nextRoleId);
                onBindingChange(nextRoleId, candidates.length === 1 ? candidates[0].sessionRef ?? '' : '');
              }}
            >
              <option value="">{roleIds.length === 0 ? labels.noRoleBindings : labels.selectRole}</option>
              {roleId && !roleValid ? <option value={roleId} disabled>{labels.invalidBinding.replace('{{value}}', roleId)}</option> : null}
              {roleIds.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            {binding ? <p className="mt-1 truncate px-1 text-xs text-muted-foreground" title={binding.agentId}>{binding.agentId}</p> : null}
          </div>
        </div>
        {showSessions ? (
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            {labels.sessionRef}
            <select
              className={fieldClassName}
              value={sessionRef}
              aria-invalid={!binding}
              aria-describedby={!binding ? `${id}-binding-hint` : undefined}
              disabled={!editable || disabled || sessions.length === 0}
              onChange={(event) => onBindingChange(roleId, event.target.value)}
            >
              <option value="">{labels.selectSession}</option>
              {sessionRef && !binding ? <option value={sessionRef} disabled>{labels.invalidBinding.replace('{{value}}', sessionRef)}</option> : null}
              {sessions.map((role) => <option key={role.sessionRef} value={role.sessionRef}>{role.sessionRef} · {role.agentId}</option>)}
            </select>
          </label>
        ) : null}
        {!binding ? <p id={`${id}-binding-hint`} className="text-xs text-destructive">{roleIds.length === 0 ? labels.noRoleBindings : labels.roleBindingRequired}</p> : null}
      </section>

      <section className="space-y-2" aria-labelledby={`${id}-prompt-label`}>
        <div className="flex items-center justify-between gap-3">
          <label id={`${id}-prompt-label`} htmlFor={`${id}-prompt`} className="text-sm font-medium">{promptLabel}</label>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            aria-expanded={expanded}
            aria-controls={`${id}-prompt`}
            disabled={disabled}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" /> : <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />}
            {expanded ? labels.collapsePrompt : labels.expandPrompt}
          </button>
        </div>
        <textarea
          id={`${id}-prompt`}
          className={`${fieldClassName} resize-y px-4 py-3 leading-7 ${expanded ? 'min-h-[60vh]' : 'min-h-72'}`}
          value={prompt}
          readOnly={!editable}
          disabled={disabled}
          onChange={(event) => onPromptChange(event.target.value)}
        />
      </section>

      {kind === 'work' ? (
        <details className="border-t border-border pt-3">
          <summary className="cursor-pointer rounded-lg text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {labels.optionalOutput}
            {outputArtifactKind ? <span className="ml-2 break-all font-normal text-foreground">{outputArtifactKind}</span> : null}
          </summary>
          <label className="mt-3 grid gap-1.5 text-xs text-muted-foreground">
            {labels.outputArtifactKind}
            <input
              className={fieldClassName}
              value={outputArtifactKind}
              readOnly={!editable}
              disabled={disabled}
              onChange={(event) => onOutputArtifactKindChange(event.target.value)}
            />
          </label>
        </details>
      ) : null}
    </div>
  );
}
