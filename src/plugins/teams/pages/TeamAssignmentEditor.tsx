import { useId, useState } from 'react';
import { Bot, Loader2, Maximize2, Minimize2, Plus, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { selectAgentsResource, useSubagentsStore } from '@/plugins/agents/stores/subagents';
import { useRuntimeEndpointsStore } from '@/plugins/runtime/directory';
import { runtimeEndpointsEqual } from '@/types/desktop/runtime-address';
import type { TeamAssignmentEditorProps } from '@/plugins/teams/pages/team-node-editor-types';

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
  bindingRequired,
  sessionCreation,
  createSessionDisabledReason,
  onCreateSession,
  onBindingChange,
  onPromptChange,
  onOutputArtifactKindChange,
}: TeamAssignmentEditorProps) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const agentsByRuntime = useSubagentsStore((state) => state.agentsByRuntime);
  const endpoints = useRuntimeEndpointsStore((state) => state.endpoints);
  const roleIds = [...new Set(roles.map((role) => role.roleId))];
  const sessions = roles.filter((role) => role.roleId === roleId);
  const roleValid = roleIds.includes(roleId);
  const binding = sessions.find((role) => role.sessionRef === sessionRef);
  const invalidRole = Boolean(roleId) && !roleValid;
  const invalidSession = Boolean(sessionRef) && !binding;
  const showBindingError = !binding && (bindingRequired || invalidRole || invalidSession);
  const sessionLabel = (value: string) => value === 'rs0'
    ? labels.defaultSession
    : labels.numberedSession.replace('{{number}}', value.slice(2));
  const memberLabel = kind === 'review' ? labels.reviewMember : labels.workMember;
  const promptLabel = kind === 'review' ? labels.reviewPrompt : labels.workPrompt;
  const fieldClassName = 'w-full min-w-0 rounded-[9px] border border-[hsl(var(--shell-border))] bg-[hsl(var(--shell-surface))] px-3 py-2.5 text-xs leading-[1.6] text-foreground hover:border-[hsl(var(--shell-border-strong))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-[hsl(var(--shell-surface-muted))]';

  return (
    <div className="space-y-[22px] max-[780px]:space-y-5">
      <section className="space-y-[9px]" aria-label={memberLabel}>
        <label htmlFor={`${id}-role`} className="block text-xs font-[550]">{memberLabel}</label>
        <div className="relative">
          <Bot aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[hsl(var(--shell-text-muted))]" strokeWidth={1.65} />
          <select
            id={`${id}-role`}
            className={`${fieldClassName} h-[41px] truncate pl-[38px]`}
            value={roleId}
            aria-invalid={invalidRole || (bindingRequired && !roleId)}
            aria-describedby={showBindingError ? `${id}-binding-hint` : undefined}
            disabled={!editable || disabled || roleIds.length === 0}
            onChange={(event) => {
              const nextRoleId = event.target.value;
              const candidates = roles.filter((role) => role.roleId === nextRoleId);
              onBindingChange(nextRoleId, candidates.length === 1 ? candidates[0].sessionRef ?? '' : '');
            }}
          >
            <option value="">{roleIds.length === 0 ? labels.noRoleBindings : labels.selectRole}</option>
            {roleId && !roleValid ? <option value={roleId} disabled>{labels.invalidBinding.replace('{{value}}', roleId)}</option> : null}
            {roleIds.map((value) => {
              const role = value === roleId && binding ? binding : roles.find((role) => role.roleId === value)!;
              const agent = selectAgentsResource({ agentsByRuntime }, role.endpointRef).data?.find((agent) => agent.id === role.agentId);
              const endpoint = role.endpointRef;
              const runtimeName = endpoints.find((entry) => runtimeEndpointsEqual(entry.endpointRef, endpoint))?.displayName
                ?? (endpoint.kind === 'native-runtime' ? `${endpoint.runtimeAdapterId} · ${endpoint.runtimeInstanceId}` : endpoint.endpointId);
              return <option key={value} value={value}>{agent?.name || agent?.identity?.name || role.agentId} · {runtimeName}</option>;
            })}
          </select>
        </div>
        {roleValid ? <div className="grid gap-[9px] pt-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <label htmlFor={`${id}-session`} className="text-xs font-[550]">{labels.sessionRef}</label>
            {editable && createSessionDisabledReason ? <span id={`${id}-session-disabled`} className="text-[11px] leading-5 text-[hsl(var(--shell-text-muted))]">{createSessionDisabledReason}</span> : null}
          </div>
          <div className="flex min-w-0 items-center gap-2.5">
            <select
              id={`${id}-session`}
              className={`${fieldClassName} h-[41px] flex-1`}
              value={sessionRef}
              aria-invalid={showBindingError}
              aria-describedby={showBindingError ? `${id}-binding-hint` : undefined}
              disabled={!editable || disabled || sessionCreation === 'pending'}
              onChange={(event) => onBindingChange(roleId, event.target.value)}
            >
              <option value="">{labels.selectSession}</option>
              {invalidSession ? <option value={sessionRef} disabled>{labels.sessionUnavailable}</option> : null}
              {sessions.map((role) => <option key={role.sessionRef} value={role.sessionRef}>{sessionLabel(role.sessionRef!)}</option>)}
            </select>
            {editable && (onCreateSession || createSessionDisabledReason) ? <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-[41px] shrink-0 gap-1.5 rounded-[9px] px-3 text-xs font-normal"
              disabled={!onCreateSession || Boolean(createSessionDisabledReason) || disabled || sessionCreation === 'pending'}
              aria-busy={sessionCreation === 'pending'}
              aria-describedby={createSessionDisabledReason ? `${id}-session-disabled` : sessionCreation === 'failed' ? `${id}-session-error` : undefined}
              title={createSessionDisabledReason}
              onClick={onCreateSession}
            >
              {sessionCreation === 'pending' ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : sessionCreation === 'failed' ? <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
              {sessionCreation === 'pending' ? labels.creatingSession : sessionCreation === 'failed' ? labels.retryCreateSession : labels.createSession}
            </Button> : null}
          </div>
        </div> : null}
        {showBindingError ? <p id={`${id}-binding-hint`} role="alert" className="text-xs text-destructive">{roleIds.length === 0 ? labels.noRoleBindings : labels.roleBindingRequired}</p> : null}
        {sessionCreation === 'failed' ? <p id={`${id}-session-error`} role="alert" className="text-xs text-destructive">{labels.createSessionFailed}</p> : null}
      </section>

      <section className="space-y-[9px]" aria-labelledby={`${id}-prompt-label`}>
        <div className="flex items-center justify-between gap-3">
          <label id={`${id}-prompt-label`} htmlFor={`${id}-prompt`} className="text-xs font-[550]">{promptLabel}</label>
          <button
            type="button"
            className="inline-flex min-h-[26px] shrink-0 items-center gap-1.5 rounded-[9px] px-[7px] py-[3px] text-[10px] text-[hsl(var(--shell-text-muted))] hover:bg-[hsl(var(--shell-surface-hover))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            aria-expanded={expanded}
            aria-controls={`${id}-prompt`}
            disabled={disabled}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <Minimize2 className="h-3 w-3" aria-hidden="true" /> : <Maximize2 className="h-3 w-3" aria-hidden="true" />}
            {expanded ? labels.collapsePrompt : labels.expandPrompt}
          </button>
        </div>
        <textarea
          id={`${id}-prompt`}
          className={`${fieldClassName} block resize-y px-[15px] py-[13px] leading-[1.95] ${expanded ? 'min-h-[48vh]' : 'min-h-[174px] max-[780px]:min-h-[185px]'}`}
          value={prompt}
          readOnly={!editable}
          disabled={disabled}
          onChange={(event) => onPromptChange(event.target.value)}
        />
      </section>

      {kind === 'work' ? (
        <details open={Boolean(outputArtifactKind)} className="border-t border-[hsl(var(--shell-border))] pt-[17px] text-[11px] leading-normal">
          <summary className="cursor-pointer rounded-sm py-0.5 text-[11px] text-[hsl(var(--shell-text-muted))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {labels.optionalOutput}
          </summary>
          <label className="mt-[17px] grid gap-[9px] text-[11px] text-[hsl(var(--shell-text-muted))]">
            {labels.outputArtifactKind}
            <input
              className={`${fieldClassName} h-[41px]`}
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
