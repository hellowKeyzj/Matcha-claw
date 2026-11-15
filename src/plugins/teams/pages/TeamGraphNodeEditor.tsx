import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { TeamNodeInspector } from '@/plugins/teams/pages/TeamNodeInspector';
import { TeamAssignmentEditor } from '@/plugins/teams/pages/TeamAssignmentEditor';
import { TeamStartEditor, readStartTrigger, buildCronExpression, normalizeWebhookPathInput, buildWebhookPublicUrl } from '@/plugins/teams/pages/TeamStartEditor';
import { TeamScriptReviewEditor } from '@/plugins/teams/pages/TeamScriptReviewEditor';
import { TeamControlNodeDetails } from '@/plugins/teams/pages/TeamControlNodeDetails';
import type { TeamGraphCanvasNodeKind, TeamGraphNodeDetailTab, TeamGraphNodeTab } from '@/plugins/teams/pages/team-node-editor-types';
import type { TeamRunGraphCanvasLabels } from '@/plugins/teams/pages/TeamRunGraphCanvas';
import type { GraphPoint } from '@/plugins/teams/pages/team-graph-layout-types';
import type { TeamGraphEdgeRecord, TeamGraphEditBase, TeamGraphNodeConfigRecord, TeamGraphNodeRecord, TeamGraphPatchOperation, TeamRoleBindingRecord, TeamScriptReviewRule } from '@/types/team-design';
import type { TeamWebhookAuthProjection } from '@/plugins/teams/services/team-runtime-client';

type TeamGraphNodeEditorProps = {
  node: TeamGraphNodeRecord;
  kind: TeamGraphCanvasNodeKind;
  initialPosition?: GraphPoint;
  nodes: TeamGraphNodeRecord[];
  edges: TeamGraphEdgeRecord[];
  roles: TeamRoleBindingRecord[];
  editable: boolean;
  mutationPending: boolean;
  mutationDisabled?: boolean;
  status: string;
  statusClassName: string;
  labels: TeamRunGraphCanvasLabels;
  webhookAuth?: TeamWebhookAuthProjection | null;
  initialTab?: TeamGraphNodeTab;
  detailTabs?: TeamGraphNodeDetailTab[];
  renderDetails?: (tab: TeamGraphNodeDetailTab, onClose: () => void, pending: boolean) => ReactNode;
  nodePatch: (node: TeamGraphNodeRecord) => Record<string, unknown>;
  onPatchGraph: (operations: TeamGraphPatchOperation[], base?: TeamGraphEditBase) => Promise<boolean>;
  onCreateSession?: (roleId: string, requestId: string) => Promise<TeamRoleBindingRecord>;
  createSessionDisabledReason?: string;
  onSaved: (nodeId: string) => void;
  onDeleted: () => void;
  onClose: () => void;
};

export function TeamGraphNodeEditor({ node, kind, initialPosition, nodes, edges, roles, editable, mutationPending, mutationDisabled = false, status, statusClassName, labels, webhookAuth, initialTab = 'config', detailTabs = [], renderDetails, nodePatch, onPatchGraph, onCreateSession, createSessionDisabledReason, onSaved, onDeleted, onClose }: TeamGraphNodeEditorProps) {
  const { t } = useTranslation('teams');
  // The keyed editor owns one open draft; snapshot readbacks only refresh its facts.
  const [activeTab, setActiveTab] = useState<TeamGraphNodeTab>(() => !initialPosition && initialTab !== 'config' && detailTabs.includes(initialTab) ? initialTab : 'config');
  const [baseNode] = useState(() => ({ title: node.title, roleId: node.roleId, config: node.config }));
  const [title, setTitle] = useState(node.title ?? '');
  const [roleId, setRoleId] = useState(node.roleId ?? '');
  const [sessionRef, setSessionRef] = useState(node.config?.sessionRef ?? '');
  const [prompt, setPrompt] = useState(node.config?.prompt ?? '');
  const [outputArtifactKind, setOutputArtifactKind] = useState(node.config?.outputArtifactKind ?? '');
  const [scriptReviewRule, setScriptReviewRule] = useState<TeamScriptReviewRule | ''>(node.config?.rule ?? '');
  const [trigger, setTrigger] = useState(() => readStartTrigger(node));
  const [webhookPublicBaseUrl, setWebhookPublicBaseUrl] = useState('');
  const [copiedWebhookPublicUrl, setCopiedWebhookPublicUrl] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [bindingRequired, setBindingRequired] = useState(false);
  const [sessionCreation, setSessionCreation] = useState<'idle' | 'pending' | 'failed'>('idle');
  const sessionRequestRef = useRef<{ requestId: string | null; pending: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifetimeRef = useRef<{ pending: boolean } | null>(null);
  const roleSessions = roles.filter((role) => role.roleId === (editable ? roleId : node.roleId));
  const selectedSessionRef = editable ? sessionRef || (roleSessions.length === 1 ? roleSessions[0].sessionRef! : '') : node.config?.sessionRef ?? '';
  const roleBindingValid = roleSessions.some((role) => role.sessionRef === selectedSessionRef);
  const pending = saving || mutationPending || sessionCreation === 'pending';
  const shownTrigger = editable ? trigger : readStartTrigger(node);

  useLayoutEffect(() => {
    lifetimeRef.current = { pending: false };
    return () => { lifetimeRef.current = null; };
  }, []);

  useLayoutEffect(() => {
    if (editable && !sessionRef && selectedSessionRef) setSessionRef(selectedSessionRef);
  }, [editable, sessionRef, selectedSessionRef]);

  useLayoutEffect(() => {
    sessionRequestRef.current = { requestId: null, pending: false };
    setSessionCreation('idle');
    return () => { sessionRequestRef.current = null; };
  }, [roleId]);

  useEffect(() => {
    setCopiedWebhookPublicUrl(false);
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, [trigger.path, webhookPublicBaseUrl]);

  const changeRoleBinding = (role: string, session: string) => {
    if (role !== roleId) sessionRequestRef.current = null;
    setRoleId(role);
    setSessionRef(session);
    setBindingRequired(false);
  };

  const createSession = async (): Promise<void> => {
    const request = sessionRequestRef.current;
    if (!request || request.pending || !editable || mutationDisabled || !onCreateSession || roleSessions.length === 0 || saving || mutationPending) return;
    request.requestId ??= crypto.randomUUID();
    request.pending = true;
    setSessionCreation('pending');
    try {
      const binding = await onCreateSession(roleId, request.requestId);
      if (sessionRequestRef.current !== request) return;
      setSessionRef(binding.sessionRef!);
      setBindingRequired(false);
      request.requestId = null;
      setSessionCreation('idle');
    } catch {
      if (sessionRequestRef.current === request) setSessionCreation('failed');
    } finally {
      request.pending = false;
    }
  };

  const submit = async (operations: TeamGraphPatchOperation[], onSuccess: () => void, base?: TeamGraphEditBase): Promise<void> => {
    const lifetime = lifetimeRef.current;
    if (!editable || mutationDisabled || !lifetime || lifetime.pending || mutationPending || sessionRequestRef.current?.pending) return;
    lifetime.pending = true;
    setSaving(true);
    setError(null);
    try {
      const saved = await onPatchGraph(operations, base);
      if (saved && lifetimeRef.current === lifetime) onSuccess();
    } catch (cause) {
      if (lifetimeRef.current === lifetime) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      lifetime.pending = false;
      if (lifetimeRef.current === lifetime) setSaving(false);
    }
  };

  const buildStartConfig = (): TeamGraphNodeConfigRecord | null => {
    if (trigger.mode === 'manual') return {};
    const path = normalizeWebhookPathInput(trigger.path);
    if (trigger.mode === 'webhook' && !path) {
      setError(labels.startWebhookPathRequired);
      return null;
    }
    if (trigger.mode === 'webhook' && path.includes('..')) {
      setError(labels.startWebhookPathInvalid);
      return null;
    }
    const cron = buildCronExpression(trigger.cron);
    if (trigger.mode === 'cron' && !cron) {
      setError(labels.startCronCustomValueRequired);
      return null;
    }
    return { trigger: trigger.mode === 'cron' ? { mode: 'cron', cron: cron! } : { mode: 'webhook', path } };
  };

  const saveNode = async (): Promise<void> => {
    if (pending || mutationDisabled) return;
    setError(null);
    setBindingRequired(true);
    let config: TeamGraphNodeConfigRecord | undefined;
    if (node.kind === 'start') {
      const startConfig = buildStartConfig();
      if (!startConfig) return;
      config = startConfig;
    }
    if (node.kind === 'script_review') {
      if (!scriptReviewRule) {
        setError(labels.scriptReviewRuleRequired);
        return;
      }
      config = { rule: scriptReviewRule };
    }
    if (node.kind === 'work' || node.kind === 'review') {
      if (!roleBindingValid) return;
      config = { prompt, sessionRef: selectedSessionRef, ...(node.kind === 'work' && outputArtifactKind.trim() ? { outputArtifactKind: outputArtifactKind.trim() } : {}) };
    }
    if (node.kind === 'human_decision') {
      config = prompt.trim() ? { prompt } : {};
    }
    const nextNode = nodePatch({ ...node, title: title.trim() || undefined, roleId, config });
    await submit(initialPosition
      ? [{ op: 'add_node', node: nextNode }, { op: 'set_node_position', nodeId: node.nodeId, position: initialPosition }]
      : [{ op: 'replace_node', node: nextNode }], () => onSaved(node.nodeId), initialPosition ? undefined : {
        node: { ...baseNode, nodeId: node.nodeId, kind: node.kind, taskId: node.taskId, reworkLimits: node.reworkLimits },
      });
  };

  const deleteNode = async (): Promise<void> => {
    if (initialPosition) { onClose(); return; }
    await submit([{ op: 'remove_node', nodeId: node.nodeId }], onDeleted);
  };

  const close = () => {
    if (!pending && !lifetimeRef.current?.pending && !sessionRequestRef.current?.pending) onClose();
  };

  const copyWebhookPublicUrl = async (): Promise<void> => {
    const text = buildWebhookPublicUrl(webhookPublicBaseUrl, trigger.path).trim();
    const lifetime = lifetimeRef.current;
    if (!text || !lifetime) return;
    try {
      await navigator.clipboard.writeText(text);
      if (lifetimeRef.current !== lifetime) return;
      setCopiedWebhookPublicUrl(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedWebhookPublicUrl(false), 1500);
    } catch (cause) {
      if (lifetimeRef.current === lifetime) setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) close(); }}>
      <TeamNodeInspector
        node={node}
        kind={kind}
        editable={editable}
        pending={pending}
        mutationDisabled={mutationDisabled}
        isNew={Boolean(initialPosition)}
        title={title}
        status={status}
        statusClassName={statusClassName}
        labels={labels}
        error={error ?? (activeTab !== 'config' && sessionCreation === 'failed' ? labels.createSessionFailed
          : activeTab !== 'config' && !roleBindingValid && (bindingRequired || (roleId && roleSessions.length === 0) || selectedSessionRef) && (kind === 'work' || kind === 'review') ? (roles.length === 0 ? labels.noRoleBindings : labels.roleBindingRequired) : null)}
        activeTab={activeTab}
        detailTabs={initialPosition ? [] : detailTabs}
        detailContent={activeTab !== 'config' ? renderDetails?.(activeTab, close, pending) : null}
        onTabChange={setActiveTab}
        onTitleChange={setTitle}
        onSave={() => { void saveNode(); }}
        onDelete={() => { void deleteNode(); }}
        onClose={close}
      >
        {kind === 'work' || kind === 'review' ? <TeamAssignmentEditor
          kind={kind}
          editable={editable}
          disabled={pending}
          labels={labels}
          roleId={editable ? roleId : node.roleId ?? ''}
          sessionRef={editable ? selectedSessionRef : node.config?.sessionRef ?? ''}
          roles={roles}
          bindingRequired={bindingRequired}
          sessionCreation={sessionCreation}
          createSessionDisabledReason={createSessionDisabledReason}
          onCreateSession={editable && !mutationDisabled && onCreateSession ? () => { void createSession(); } : undefined}
          prompt={editable ? prompt : node.config?.prompt ?? ''}
          outputArtifactKind={editable ? outputArtifactKind : node.config?.outputArtifactKind ?? ''}
          onBindingChange={changeRoleBinding}
          onPromptChange={setPrompt}
          onOutputArtifactKindChange={setOutputArtifactKind}
        /> : null}
        {kind === 'start' ? <TeamStartEditor
          editable={editable}
          disabled={pending}
          labels={labels}
          triggerMode={shownTrigger.mode}
          webhookPath={shownTrigger.path}
          webhookPublicBaseUrl={webhookPublicBaseUrl}
          cronSchedule={shownTrigger.cron}
          webhookAuth={webhookAuth}
          copiedWebhookPublicUrl={copiedWebhookPublicUrl}
          onTriggerModeChange={(mode) => setTrigger((current) => ({ ...current, mode }))}
          onWebhookPathChange={(path) => setTrigger((current) => ({ ...current, path }))}
          onWebhookPublicBaseUrlChange={setWebhookPublicBaseUrl}
          onCronScheduleChange={(cron) => setTrigger((current) => ({ ...current, cron }))}
          onCopyWebhookPublicUrl={() => { void copyWebhookPublicUrl(); }}
        /> : null}
        {kind === 'script_review' ? <TeamScriptReviewEditor
          editable={editable}
          disabled={pending}
          labels={labels}
          rule={editable ? scriptReviewRule : node.config?.rule ?? ''}
          onRuleChange={setScriptReviewRule}
        /> : null}
        {kind === 'human_decision' ? <label className="grid gap-[9px] text-xs font-[550]">
          {t('workspace.approvalContent')}
          <textarea
            className="block min-h-[174px] w-full min-w-0 resize-y rounded-[9px] border border-[hsl(var(--shell-border))] bg-[hsl(var(--shell-surface))] px-[15px] py-[13px] text-xs font-normal leading-[1.95] text-foreground hover:border-[hsl(var(--shell-border-strong))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-[hsl(var(--shell-surface-muted))]"
            value={editable ? prompt : node.config?.prompt ?? ''}
            readOnly={!editable}
            disabled={pending}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label> : null}
        {kind === 'human_decision' || kind === 'join' || kind === 'end' || kind === 'review' || kind === 'script_review' ? <TeamControlNodeDetails
          kind={kind}
          node={node}
          nodes={nodes}
          edges={edges}
          labels={labels}
        /> : null}
      </TeamNodeInspector>
    </DialogPrimitive.Root>
  );
}
