import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { hostApiFetch } from '@/lib/host-api';
import { useTranslation } from 'react-i18next';
import { ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type SecurityAction = 'allow' | 'confirm' | 'deny';
type SecurityPreset = 'strict' | 'balanced' | 'relaxed';
type ConfirmStrategy = 'every_time' | 'session';
type ToolPolicyField = 'allowTools' | 'confirmTools' | 'denyTools';
type EditableFieldKey = Exclude<keyof AgentSecurityPolicy, 'preset'>;
type ToolConflictState = {
  toolName: string;
  targetField: ToolPolicyField;
  fromFields: ToolPolicyField[];
};

interface AgentSecurityPolicy {
  preset: SecurityPreset;
  defaultAction: SecurityAction;
  allowTools: string[];
  confirmTools: string[];
  denyTools: string[];
  allowPathPrefixes: string[];
  allowDomains: string[];
  allowCommandExecution: boolean;
  allowDependencyInstall: boolean;
  confirmStrategy: ConfirmStrategy;
  capabilities: string[];
}

type AgentSecurityPolicyPatch = Partial<AgentSecurityPolicy>;

interface SettingsPayload {
  securityPreset?: unknown;
  securityPolicyVersion?: unknown;
  securityPolicyByAgent?: unknown;
}

interface EffectiveToolsPayload {
  success?: boolean;
  tools?: Array<{ id?: unknown; name?: unknown }>;
}

type PolicySource = 'immutableRules' | 'userOverride' | 'preset' | 'default';

interface GuardianAuditItem {
  ts: number;
  toolName: string;
  risk: string;
  action: string;
  decision: string;
  policyPreset?: string;
  ruleId?: string;
}

interface GuardianAuditQueryResult {
  page: number;
  pageSize: number;
  total: number;
  items: GuardianAuditItem[];
}

const DEFAULT_ALLOW_TOOLS = [
  'task_create',
  'task_set_plan_markdown',
  'task_bind_session',
  'task_request_user_input',
  'task_wait_approval',
  'task_mark_failed',
  'task_list',
  'task_get',
  'task_resume',
  'sessions_list',
  'memory_get',
  'memory_search',
];

const DEFAULT_CONFIRM_TOOLS = [
  'system.run',
  'nodes.run',
  'fs.write_file',
  'fs.delete_file',
  'fs.remove',
  'http.request',
];

const DEFAULT_DENY_TOOLS = [
  'system.disable_guardian',
  'security.disable_guard',
];

const TOOL_OPTION_CATALOG = [
  ...DEFAULT_ALLOW_TOOLS,
  ...DEFAULT_CONFIRM_TOOLS,
  ...DEFAULT_DENY_TOOLS,
  'fs.read_file',
  'fs.list_dir',
  'fs.stat',
  'sessions_send',
  'sessions_spawn',
  'sessions_history',
  'session_status',
  'agents_list',
  'web_search',
  'web_fetch',
  'gateway',
];

const CAPABILITY_OPTION_CATALOG = [
  'CAP_READ_LOCAL_FILES',
  'CAP_WRITE_LOCAL_FILES',
  'CAP_EXECUTE_COMMAND',
  'CAP_NETWORK_REQUEST',
  'CAP_INSTALL_DEPENDENCY',
];

const TOOL_LABEL_KEY_MAP: Record<string, string> = {
  task_create: 'task_create',
  task_set_plan_markdown: 'task_set_plan_markdown',
  task_bind_session: 'task_bind_session',
  task_request_user_input: 'task_request_user_input',
  task_wait_approval: 'task_wait_approval',
  task_mark_failed: 'task_mark_failed',
  task_list: 'task_list',
  task_get: 'task_get',
  task_resume: 'task_resume',
  sessions_list: 'sessions_list',
  sessions_send: 'sessions_send',
  sessions_spawn: 'sessions_spawn',
  sessions_history: 'sessions_history',
  session_status: 'session_status',
  memory_get: 'memory_get',
  memory_search: 'memory_search',
  'system.run': 'system_run',
  'nodes.run': 'nodes_run',
  'fs.write_file': 'fs_write_file',
  'fs.delete_file': 'fs_delete_file',
  'fs.remove': 'fs_remove',
  'fs.read_file': 'fs_read_file',
  'fs.list_dir': 'fs_list_dir',
  'fs.stat': 'fs_stat',
  'http.request': 'http_request',
  web_search: 'web_search',
  web_fetch: 'web_fetch',
  agents_list: 'agents_list',
  gateway: 'gateway',
  'system.disable_guardian': 'system_disable_guardian',
  'security.disable_guard': 'security_disable_guard',
};

const PRESET_BASE_CONFIG: Record<SecurityPreset, {
  defaultAction: SecurityAction;
  allowCommandExecution: boolean;
  allowDependencyInstall: boolean;
  confirmStrategy: ConfirmStrategy;
  capabilities: string[];
}> = {
  strict: {
    defaultAction: 'deny',
    allowCommandExecution: false,
    allowDependencyInstall: false,
    confirmStrategy: 'every_time',
    capabilities: ['CAP_READ_LOCAL_FILES', 'CAP_NETWORK_REQUEST'],
  },
  balanced: {
    defaultAction: 'confirm',
    allowCommandExecution: true,
    allowDependencyInstall: false,
    confirmStrategy: 'session',
    capabilities: ['CAP_READ_LOCAL_FILES', 'CAP_WRITE_LOCAL_FILES', 'CAP_EXECUTE_COMMAND', 'CAP_NETWORK_REQUEST'],
  },
  relaxed: {
    defaultAction: 'allow',
    allowCommandExecution: true,
    allowDependencyInstall: true,
    confirmStrategy: 'every_time',
    capabilities: ['CAP_READ_LOCAL_FILES', 'CAP_WRITE_LOCAL_FILES', 'CAP_EXECUTE_COMMAND', 'CAP_NETWORK_REQUEST', 'CAP_INSTALL_DEPENDENCY'],
  },
};

const PRESET_TOOL_CONFIG: Record<SecurityPreset, {
  allowTools: string[];
  confirmTools: string[];
  denyTools: string[];
}> = {
  strict: {
    allowTools: [...DEFAULT_ALLOW_TOOLS],
    confirmTools: [...DEFAULT_CONFIRM_TOOLS],
    denyTools: [...DEFAULT_DENY_TOOLS],
  },
  balanced: {
    allowTools: [...DEFAULT_ALLOW_TOOLS],
    confirmTools: [...DEFAULT_CONFIRM_TOOLS],
    denyTools: [...DEFAULT_DENY_TOOLS],
  },
  relaxed: {
    allowTools: [...DEFAULT_ALLOW_TOOLS],
    confirmTools: [],
    denyTools: [...DEFAULT_DENY_TOOLS],
  },
};

function buildPresetPolicy(preset: SecurityPreset): AgentSecurityPolicy {
  const base = PRESET_BASE_CONFIG[preset] ?? PRESET_BASE_CONFIG.balanced;
  const toolBase = PRESET_TOOL_CONFIG[preset] ?? PRESET_TOOL_CONFIG.balanced;
  return {
    preset,
    defaultAction: base.defaultAction,
    allowTools: [...toolBase.allowTools],
    confirmTools: [...toolBase.confirmTools],
    denyTools: [...toolBase.denyTools],
    allowPathPrefixes: [],
    allowDomains: [],
    allowCommandExecution: base.allowCommandExecution,
    allowDependencyInstall: base.allowDependencyInstall,
    confirmStrategy: base.confirmStrategy,
    capabilities: [...base.capabilities],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeToolList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = item.trim();
    if (!normalized) {
      continue;
    }
    unique.add(normalized);
  }
  return [...unique];
}

function normalizePolicyOverride(value: unknown): AgentSecurityPolicyPatch {
  if (!isRecord(value)) {
    return {};
  }

  const output: AgentSecurityPolicyPatch = {};
  const preset = value.preset === 'strict' || value.preset === 'balanced' || value.preset === 'relaxed'
    ? value.preset
    : undefined;
  const defaultAction = value.defaultAction === 'allow' || value.defaultAction === 'confirm' || value.defaultAction === 'deny'
    ? value.defaultAction
    : undefined;
  const confirmStrategy = value.confirmStrategy === 'every_time' || value.confirmStrategy === 'session'
    ? value.confirmStrategy
    : undefined;
  if (preset) output.preset = preset;
  if (defaultAction) output.defaultAction = defaultAction;
  if (confirmStrategy) output.confirmStrategy = confirmStrategy;

  const assignList = (key: keyof AgentSecurityPolicyPatch) => {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      output[key] = normalizeToolList(value[key]) as never;
    }
  };
  assignList('allowTools');
  assignList('confirmTools');
  assignList('denyTools');
  assignList('allowPathPrefixes');
  assignList('allowDomains');
  assignList('capabilities');

  if (Object.prototype.hasOwnProperty.call(value, 'allowCommandExecution') && typeof value.allowCommandExecution === 'boolean') {
    output.allowCommandExecution = value.allowCommandExecution;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'allowDependencyInstall') && typeof value.allowDependencyInstall === 'boolean') {
    output.allowDependencyInstall = value.allowDependencyInstall;
  }
  return output;
}

function normalizePolicyMap(value: unknown): Record<string, AgentSecurityPolicyPatch> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, AgentSecurityPolicyPatch> = {};
  for (const [agentId, policyValue] of Object.entries(value)) {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) {
      continue;
    }
    result[normalizedAgentId] = normalizePolicyOverride(policyValue);
  }
  return result;
}

function parseToolListText(input: string): string[] {
  const normalizedInput = input.replace(/\n/g, ',');
  return normalizeToolList(normalizedInput.split(',').map((item) => item.trim()));
}

function formatToolListText(list: string[]): string {
  return list.join(', ');
}

function listEqual(a: string[] | undefined, b: string[]): boolean {
  const left = Array.isArray(a) ? a : [];
  if (left.length !== b.length) {
    return false;
  }
  return left.every((item, index) => item === b[index]);
}

function uniqueList(items: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function clonePolicyMap(map: Record<string, AgentSecurityPolicyPatch>): Record<string, AgentSecurityPolicyPatch> {
  const cloned: Record<string, AgentSecurityPolicyPatch> = {};
  for (const [agentId, patch] of Object.entries(map)) {
    cloned[agentId] = {
      ...patch,
      ...(Array.isArray(patch.allowTools) ? { allowTools: [...patch.allowTools] } : {}),
      ...(Array.isArray(patch.confirmTools) ? { confirmTools: [...patch.confirmTools] } : {}),
      ...(Array.isArray(patch.denyTools) ? { denyTools: [...patch.denyTools] } : {}),
      ...(Array.isArray(patch.allowPathPrefixes) ? { allowPathPrefixes: [...patch.allowPathPrefixes] } : {}),
      ...(Array.isArray(patch.allowDomains) ? { allowDomains: [...patch.allowDomains] } : {}),
      ...(Array.isArray(patch.capabilities) ? { capabilities: [...patch.capabilities] } : {}),
    };
  }
  return cloned;
}

function compactPolicyOverride(
  override: AgentSecurityPolicyPatch,
  globalPreset: SecurityPreset,
): AgentSecurityPolicyPatch {
  const preset = override.preset ?? globalPreset;
  const baseline = buildPresetPolicy(preset);
  const compact: AgentSecurityPolicyPatch = {};

  if (override.preset && override.preset !== globalPreset) {
    compact.preset = override.preset;
  }
  if (override.defaultAction && override.defaultAction !== baseline.defaultAction) {
    compact.defaultAction = override.defaultAction;
  }
  if (Object.prototype.hasOwnProperty.call(override, 'allowTools') && !listEqual(override.allowTools, baseline.allowTools)) {
    compact.allowTools = override.allowTools ?? [];
  }
  if (Object.prototype.hasOwnProperty.call(override, 'confirmTools') && !listEqual(override.confirmTools, baseline.confirmTools)) {
    compact.confirmTools = override.confirmTools ?? [];
  }
  if (Object.prototype.hasOwnProperty.call(override, 'denyTools') && !listEqual(override.denyTools, baseline.denyTools)) {
    compact.denyTools = override.denyTools ?? [];
  }
  if (Object.prototype.hasOwnProperty.call(override, 'allowPathPrefixes') && !listEqual(override.allowPathPrefixes, baseline.allowPathPrefixes)) {
    compact.allowPathPrefixes = override.allowPathPrefixes ?? [];
  }
  if (Object.prototype.hasOwnProperty.call(override, 'allowDomains') && !listEqual(override.allowDomains, baseline.allowDomains)) {
    compact.allowDomains = override.allowDomains ?? [];
  }
  if (Object.prototype.hasOwnProperty.call(override, 'allowCommandExecution')
    && typeof override.allowCommandExecution === 'boolean'
    && override.allowCommandExecution !== baseline.allowCommandExecution) {
    compact.allowCommandExecution = override.allowCommandExecution;
  }
  if (Object.prototype.hasOwnProperty.call(override, 'allowDependencyInstall')
    && typeof override.allowDependencyInstall === 'boolean'
    && override.allowDependencyInstall !== baseline.allowDependencyInstall) {
    compact.allowDependencyInstall = override.allowDependencyInstall;
  }
  if (override.confirmStrategy && override.confirmStrategy !== baseline.confirmStrategy) {
    compact.confirmStrategy = override.confirmStrategy;
  }
  if (Object.prototype.hasOwnProperty.call(override, 'capabilities') && !listEqual(override.capabilities, baseline.capabilities)) {
    compact.capabilities = override.capabilities ?? [];
  }
  return compact;
}

function resolveRuleSource(ruleId: string | undefined): PolicySource {
  if (!ruleId) {
    return 'default';
  }
  if (ruleId.startsWith('immutable.')) {
    return 'immutableRules';
  }
  if (ruleId.startsWith('user.')) {
    return 'userOverride';
  }
  if (ruleId.startsWith('preset.')) {
    return 'preset';
  }
  if (ruleId.startsWith('policy.')) {
    return 'default';
  }
  return 'preset';
}

function sourceBadgeVariant(source: PolicySource): 'destructive' | 'default' | 'secondary' | 'outline' {
  if (source === 'immutableRules') {
    return 'destructive';
  }
  if (source === 'userOverride') {
    return 'default';
  }
  if (source === 'preset') {
    return 'secondary';
  }
  return 'outline';
}

export function SecurityPage() {
  const { t } = useTranslation('security');
  const navigate = useNavigate();
  const agents = useSubagentsStore((state) => state.agents);
  const loadAgents = useSubagentsStore((state) => state.loadAgents);
  const gatewayState = useGatewayStore((state) => state.status.state);
  const gatewayRpc = useGatewayStore((state) => state.rpc);
  const wasGatewayRunningRef = useRef(gatewayState === 'running');

  const [loadingPolicies, setLoadingPolicies] = useState(true);
  const [savingPolicies, setSavingPolicies] = useState(false);
  const [securityPreset, setSecurityPreset] = useState<SecurityPreset>('balanced');
  const [policyVersion, setPolicyVersion] = useState(1);
  const [policyByAgent, setPolicyByAgent] = useState<Record<string, AgentSecurityPolicyPatch>>({});
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [auditItems, setAuditItems] = useState<GuardianAuditItem[]>([]);
  const [effectiveToolIds, setEffectiveToolIds] = useState<string[]>([]);
  const [effectiveToolNames, setEffectiveToolNames] = useState<Record<string, string>>({});
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExplainDetails, setShowExplainDetails] = useState(false);
  const [showAuditDetails, setShowAuditDetails] = useState(false);
  const [editingField, setEditingField] = useState<EditableFieldKey | null>(null);
  const [editorSnapshot, setEditorSnapshot] = useState<Record<string, AgentSecurityPolicyPatch> | null>(null);
  const [toolConflict, setToolConflict] = useState<ToolConflictState | null>(null);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    const isGatewayRunning = gatewayState === 'running';
    if (isGatewayRunning && !wasGatewayRunningRef.current) {
      void loadAgents();
    }
    wasGatewayRunningRef.current = isGatewayRunning;
  }, [gatewayState, loadAgents]);

  const loadPolicies = useCallback(async () => {
    setLoadingPolicies(true);
    setError(null);
    try {
      const payload = await hostApiFetch<SettingsPayload>('/api/settings');
      const nextPreset = payload.securityPreset === 'strict' || payload.securityPreset === 'balanced' || payload.securityPreset === 'relaxed'
        ? payload.securityPreset
        : 'balanced';
      const nextVersion = typeof payload.securityPolicyVersion === 'number'
        ? payload.securityPolicyVersion
        : 1;
      const nextPolicyMapRaw = normalizePolicyMap(payload.securityPolicyByAgent);
      const nextPolicyMap: Record<string, AgentSecurityPolicyPatch> = {};
      for (const [agentId, override] of Object.entries(nextPolicyMapRaw)) {
        const compact = compactPolicyOverride(override, nextPreset);
        if (Object.keys(compact).length > 0) {
          nextPolicyMap[agentId] = compact;
        }
      }
      setSecurityPreset(nextPreset);
      setPolicyVersion(nextVersion);
      setPolicyByAgent(nextPolicyMap);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : t('errors.loadFailed');
      setError(message);
    } finally {
      setLoadingPolicies(false);
    }
  }, [t]);

  useEffect(() => {
    void loadPolicies();
  }, [loadPolicies]);

  useEffect(() => {
    if (agents.length === 0) {
      setSelectedAgentId('');
      return;
    }
    const hasSelected = selectedAgentId && agents.some((agent) => agent.id === selectedAgentId);
    if (!hasSelected) {
      setSelectedAgentId(agents[0].id);
    }
  }, [agents, selectedAgentId]);

  const selectedPolicyRaw = selectedAgentId ? policyByAgent[selectedAgentId] : undefined;
  const selectedPreset = (selectedPolicyRaw?.preset ?? securityPreset) as SecurityPreset;
  const selectedPolicy = useMemo(() => ({
    ...buildPresetPolicy(selectedPreset),
    ...(selectedPolicyRaw ?? {}),
    preset: selectedPreset,
  }), [selectedPreset, selectedPolicyRaw]);
  const selectedPolicyRawRecord = selectedPolicyRaw && isRecord(selectedPolicyRaw)
    ? selectedPolicyRaw
    : undefined;
  const toolOptions = useMemo(
    () => uniqueList([
      ...TOOL_OPTION_CATALOG,
      ...effectiveToolIds,
      ...auditItems.map((item) => item.toolName || ''),
    ]),
    [auditItems, effectiveToolIds],
  );

  const resolveFieldSource = (field: keyof AgentSecurityPolicy): PolicySource => {
    if (selectedPolicyRawRecord && Object.prototype.hasOwnProperty.call(selectedPolicyRawRecord, field)) {
      return 'userOverride';
    }
    return 'preset';
  };

  const policySourceRows: Array<{ key: keyof AgentSecurityPolicy; label: string }> = useMemo(() => ([
    { key: 'defaultAction', label: t('form.defaultAction') },
    { key: 'allowTools', label: t('form.allowTools') },
    { key: 'confirmTools', label: t('form.confirmTools') },
    { key: 'denyTools', label: t('form.denyTools') },
    { key: 'allowPathPrefixes', label: t('form.allowPathPrefixes') },
    { key: 'allowDomains', label: t('form.allowDomains') },
    { key: 'allowCommandExecution', label: t('form.allowCommandExecution') },
    { key: 'allowDependencyInstall', label: t('form.allowDependencyInstall') },
    { key: 'confirmStrategy', label: t('form.confirmStrategy') },
    { key: 'capabilities', label: t('form.capabilities') },
  ]), [t]);

  const applyGlobalPreset = (nextPreset: SecurityPreset) => {
    setSecurityPreset(nextPreset);
    setPolicyByAgent((prev) => {
      const next: Record<string, AgentSecurityPolicyPatch> = {};
      for (const [agentId, override] of Object.entries(prev)) {
        const compact = compactPolicyOverride(override, nextPreset);
        if (Object.keys(compact).length > 0) {
          next[agentId] = compact;
        }
      }
      return next;
    });
  };

  const updateSelectedPolicy = (patch: Partial<AgentSecurityPolicy>) => {
    if (!selectedAgentId) {
      return;
    }
    setPolicyByAgent((prev) => {
      const current = prev[selectedAgentId] ?? {};
      const merged: AgentSecurityPolicyPatch = {
        ...current,
        ...patch,
      };
      const compact = compactPolicyOverride(merged, securityPreset);
      if (Object.keys(compact).length === 0) {
        if (!prev[selectedAgentId]) {
          return prev;
        }
        const next = { ...prev };
        delete next[selectedAgentId];
        return next;
      }
      return {
        ...prev,
        [selectedAgentId]: compact,
      };
    });
  };
  const toggleCapabilityValue = useCallback((value: string) => {
    const current = selectedPolicy.capabilities;
    const exists = current.includes(value);
    const next = exists ? current.filter((item) => item !== value) : [...current, value];
    updateSelectedPolicy({ capabilities: next });
  }, [selectedPolicy, updateSelectedPolicy]);
  const applyToolSelection = useCallback((field: ToolPolicyField, toolName: string) => {
    const allow = selectedPolicy.allowTools.filter((item) => item !== toolName);
    const confirm = selectedPolicy.confirmTools.filter((item) => item !== toolName);
    const deny = selectedPolicy.denyTools.filter((item) => item !== toolName);
    if (field === 'allowTools') {
      updateSelectedPolicy({
        allowTools: [...allow, toolName],
        confirmTools: confirm,
        denyTools: deny,
      });
      return;
    }
    if (field === 'confirmTools') {
      updateSelectedPolicy({
        allowTools: allow,
        confirmTools: [...confirm, toolName],
        denyTools: deny,
      });
      return;
    }
    updateSelectedPolicy({
      allowTools: allow,
      confirmTools: confirm,
      denyTools: [...deny, toolName],
    });
  }, [selectedPolicy.allowTools, selectedPolicy.confirmTools, selectedPolicy.denyTools, updateSelectedPolicy]);
  const toggleToolInField = useCallback((field: ToolPolicyField, toolName: string) => {
    const current =
      field === 'allowTools' ? selectedPolicy.allowTools
        : field === 'confirmTools' ? selectedPolicy.confirmTools
          : selectedPolicy.denyTools;
    const existsInTarget = current.includes(toolName);
    if (existsInTarget) {
      updateSelectedPolicy({ [field]: current.filter((item) => item !== toolName) });
      return;
    }

    const fromFields: ToolPolicyField[] = [];
    if (field !== 'allowTools' && selectedPolicy.allowTools.includes(toolName)) {
      fromFields.push('allowTools');
    }
    if (field !== 'confirmTools' && selectedPolicy.confirmTools.includes(toolName)) {
      fromFields.push('confirmTools');
    }
    if (field !== 'denyTools' && selectedPolicy.denyTools.includes(toolName)) {
      fromFields.push('denyTools');
    }

    if (fromFields.length > 0) {
      setToolConflict({ toolName, targetField: field, fromFields });
      return;
    }
    applyToolSelection(field, toolName);
  }, [applyToolSelection, selectedPolicy.allowTools, selectedPolicy.confirmTools, selectedPolicy.denyTools, updateSelectedPolicy]);
  const formatToolLabel = useCallback((toolId: string): string => {
    const fromGateway = effectiveToolNames[toolId];
    if (fromGateway && fromGateway.trim().length > 0 && fromGateway !== toolId) {
      return fromGateway;
    }
    const key = TOOL_LABEL_KEY_MAP[toolId];
    if (!key) {
      return toolId;
    }
    return t(`toolLabels.${key}`, { defaultValue: toolId });
  }, [effectiveToolNames, t]);
  const formatCapabilityLabel = useCallback((capability: string): string => (
    t(`capabilityLabels.${capability}`, { defaultValue: capability })
  ), [t]);
  const handleSave = async (
    nextPreset: SecurityPreset = securityPreset,
    nextPolicyByAgent: Record<string, AgentSecurityPolicyPatch> = policyByAgent,
  ) => {
    setSavingPolicies(true);
    setError(null);
    try {
      await hostApiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          securityPreset: nextPreset,
          securityPolicyVersion: policyVersion || 1,
          securityPolicyByAgent: nextPolicyByAgent,
        }),
      });
      toast.success(t('messages.saved'));
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : t('errors.saveFailed');
      setError(message);
      toast.error(t('messages.saveFailed'));
    } finally {
      setSavingPolicies(false);
    }
  };

  const handleResetAgentPolicy = () => {
    if (!selectedAgentId) {
      return;
    }
    setPolicyByAgent((prev) => {
      if (!prev[selectedAgentId]) {
        return prev;
      }
      const next = { ...prev };
      delete next[selectedAgentId];
      return next;
    });
  };

  const formatFieldPreview = useCallback((field: EditableFieldKey): string => {
    if (field === 'defaultAction') {
      return t(`action.${selectedPolicy.defaultAction}`);
    }
    if (field === 'allowCommandExecution' || field === 'allowDependencyInstall') {
      return selectedPolicy[field] ? t('form.valueEnabled') : t('form.valueDisabled');
    }
    if (field === 'confirmStrategy') {
      return t(`confirmStrategy.${selectedPolicy.confirmStrategy}`);
    }
    if (field === 'allowPathPrefixes' || field === 'allowDomains' || field === 'capabilities' || field === 'allowTools' || field === 'confirmTools' || field === 'denyTools') {
      return t('form.valueCount', { count: selectedPolicy[field].length });
    }
    return '-';
  }, [selectedPolicy, t]);

  const openFieldEditor = useCallback((field: EditableFieldKey) => {
    setEditorSnapshot(clonePolicyMap(policyByAgent));
    setEditingField(field);
  }, [policyByAgent]);

  const closeFieldEditor = useCallback((restore: boolean) => {
    if (restore && editorSnapshot) {
      setPolicyByAgent(clonePolicyMap(editorSnapshot));
    }
    setToolConflict(null);
    setEditingField(null);
    setEditorSnapshot(null);
  }, [editorSnapshot]);

  const handleSaveFieldEditor = useCallback(async () => {
    await handleSave();
    setEditorSnapshot(clonePolicyMap(policyByAgent));
  }, [handleSave, policyByAgent]);

  const handleUsePresetForField = useCallback(async () => {
    if (!editingField || !selectedAgentId) {
      return;
    }
    const current = policyByAgent[selectedAgentId];
    if (!current || !Object.prototype.hasOwnProperty.call(current, editingField)) {
      closeFieldEditor(false);
      return;
    }
    const merged: AgentSecurityPolicyPatch = { ...current };
    delete (merged as Record<string, unknown>)[editingField];
    const compact = compactPolicyOverride(merged, securityPreset);
    const nextMap = clonePolicyMap(policyByAgent);
    if (Object.keys(compact).length === 0) {
      delete nextMap[selectedAgentId];
    } else {
      nextMap[selectedAgentId] = compact;
    }
    setPolicyByAgent(nextMap);
    await handleSave(securityPreset, nextMap);
    closeFieldEditor(false);
  }, [closeFieldEditor, editingField, handleSave, policyByAgent, securityPreset, selectedAgentId]);

  const loadRecentAudits = useCallback(async () => {
    if (!selectedAgentId || gatewayState !== 'running') {
      setAuditItems([]);
      return;
    }
    setLoadingAudit(true);
    try {
      const result = await gatewayRpc<GuardianAuditQueryResult>(
        'guardian.audit.query',
        { agentId: selectedAgentId, page: 1, pageSize: 8 },
        8000,
      );
      setAuditItems(Array.isArray(result.items) ? result.items : []);
    } catch {
      setAuditItems([]);
    } finally {
      setLoadingAudit(false);
    }
  }, [gatewayRpc, gatewayState, selectedAgentId]);

  const loadEffectiveTools = useCallback(async () => {
    if (gatewayState !== 'running') {
      setEffectiveToolIds([]);
      setEffectiveToolNames({});
      return;
    }
    try {
      const payload = await hostApiFetch<EffectiveToolsPayload>('/api/skills/effective');
      if (!payload?.success || !Array.isArray(payload.tools)) {
        setEffectiveToolIds([]);
        setEffectiveToolNames({});
        return;
      }
      const nextNames: Record<string, string> = {};
      const ids = payload.tools
        .map((tool) => {
          const id = typeof tool?.id === 'string' ? tool.id.trim() : '';
          const name = typeof tool?.name === 'string' ? tool.name.trim() : '';
          if (id && name) {
            nextNames[id] = name;
          }
          return id || name;
        })
        .filter((item) => item.length > 0);
      setEffectiveToolIds(uniqueList(ids));
      setEffectiveToolNames(nextNames);
    } catch {
      setEffectiveToolIds([]);
      setEffectiveToolNames({});
    }
  }, [gatewayState]);

  useEffect(() => {
    void loadRecentAudits();
  }, [loadRecentAudits]);

  useEffect(() => {
    void loadEffectiveTools();
  }, [loadEffectiveTools]);

  if (loadingPolicies) {
    return (
      <section className="space-y-4">
        <header>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </header>
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
      </header>

      {error && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {agents.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('empty.title')}</CardTitle>
            <CardDescription>{t('empty.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate('/subagents')}>{t('empty.action')}</Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-col gap-4">
          <Card className="order-1">
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <div className="space-y-1">
                <CardTitle>{t('explain.title')}</CardTitle>
                <CardDescription>{t('explain.description')}</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="security-global-preset" className="shrink-0 text-xs text-muted-foreground">{t('form.globalPreset')}</Label>
                  <Select
                    id="security-global-preset"
                    className="w-44"
                    value={securityPreset}
                    onChange={(event) => applyGlobalPreset(event.target.value as SecurityPreset)}
                  >
                    <option value="strict">{t('preset.strict')}</option>
                    <option value="balanced">{t('preset.balanced')}</option>
                    <option value="relaxed">{t('preset.relaxed')}</option>
                  </Select>
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  onClick={() => setShowExplainDetails((prev) => !prev)}
                  aria-label={showExplainDetails ? t('explain.collapse') : t('explain.expand')}
                  title={showExplainDetails ? t('explain.collapse') : t('explain.expand')}
                >
                  <ChevronDown className={`h-4 w-4 transition-transform ${showExplainDetails ? 'rotate-180' : ''}`} />
                </Button>
              </div>
            </CardHeader>
            {showExplainDetails && (
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted-foreground">{t('explain.priorityOrder')}</span>
                  <Badge variant={sourceBadgeVariant('immutableRules')}>{t('source.immutableRules')}</Badge>
                  <span className="text-muted-foreground">→</span>
                  <Badge variant={sourceBadgeVariant('userOverride')}>{t('source.userOverride')}</Badge>
                  <span className="text-muted-foreground">→</span>
                  <Badge variant={sourceBadgeVariant('preset')}>{t('source.preset')}</Badge>
                  <span className="text-muted-foreground">→</span>
                  <Badge variant={sourceBadgeVariant('default')}>{t('source.default')}</Badge>
                </div>
                <div className="rounded-md border p-3 text-xs text-muted-foreground">
                  <p>{t('explain.immutableRulesHint')}</p>
                  <p className="mt-1">1. {t('explain.immutable1')}</p>
                  <p>2. {t('explain.immutable2')}</p>
                  <p>3. {t('explain.immutable3')}</p>
                  <p>4. {t('explain.immutable4')}</p>
                </div>
                <div className="rounded-md border p-3">
                  <div className="mb-2 flex flex-wrap items-end gap-2">
                    <div className="min-w-48 flex-1 space-y-1">
                      <p className="text-xs text-muted-foreground">{t('explain.fieldSourceTitle')}</p>
                      <Select
                        id="security-agent-in-explain"
                        value={selectedAgentId}
                        onChange={(event) => setSelectedAgentId(event.target.value)}
                      >
                        {agents.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.name || agent.id}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    {policySourceRows.map((row) => {
                      const fieldKey = row.key as EditableFieldKey;
                      const source = resolveFieldSource(fieldKey);
                      return (
                        <button
                          key={row.key}
                          type="button"
                          onClick={() => openFieldEditor(fieldKey)}
                          className="flex items-center justify-between rounded border px-2 py-2 text-left transition-colors hover:bg-muted/40"
                        >
                          <div className="space-y-0.5">
                            <span className="text-xs">{row.label}</span>
                            <p className="text-xs text-muted-foreground">{formatFieldPreview(fieldKey)}</p>
                          </div>
                          <Badge variant={sourceBadgeVariant(source)}>{t(`source.${source}`)}</Badge>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" variant="outline" onClick={handleResetAgentPolicy}>
                    {t('actions.resetAgent')}
                  </Button>
                  <Button type="button" onClick={() => void handleSave()} disabled={savingPolicies}>
                    {savingPolicies ? t('actions.saving') : t('actions.save')}
                  </Button>
                </div>
              </CardContent>
            )}
          </Card>

          <Card className="order-3">
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <div className="space-y-1">
                <CardTitle>{t('audit.title')}</CardTitle>
                <CardDescription>{t('audit.description')}</CardDescription>
              </div>
              <Button
                type="button"
                size="icon"
                variant="outline"
                onClick={() => setShowAuditDetails((prev) => !prev)}
                aria-label={showAuditDetails ? t('audit.collapse') : t('audit.expand')}
                title={showAuditDetails ? t('audit.collapse') : t('audit.expand')}
              >
                <ChevronDown className={`h-4 w-4 transition-transform ${showAuditDetails ? 'rotate-180' : ''}`} />
              </Button>
            </CardHeader>
            {showAuditDetails && (
            <CardContent className="space-y-3">
              {gatewayState !== 'running' ? (
                <p className="text-sm text-muted-foreground">{t('audit.gatewayStopped')}</p>
              ) : loadingAudit ? (
                <p className="text-sm text-muted-foreground">{t('audit.loading')}</p>
              ) : auditItems.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('audit.empty')}</p>
              ) : (
                <div className="space-y-2">
                  {auditItems.map((item, index) => {
                    const source = resolveRuleSource(item.ruleId);
                    return (
                      <div key={`${item.ts}-${index}`} className="rounded-md border p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="text-sm font-medium">{item.toolName || '-'}</div>
                          <div className="flex items-center gap-2">
                            <Badge variant={sourceBadgeVariant(source)}>{t(`source.${source}`)}</Badge>
                            <Badge variant="outline">{item.risk}</Badge>
                            <Badge variant="outline">{item.action}</Badge>
                          </div>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {new Date(item.ts).toLocaleString()} · rule: {item.ruleId || '-'} · preset: {item.policyPreset || '-'} · decision: {item.decision || '-'}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
            )}
          </Card>

          {editingField && (
            <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
              <section
                role="dialog"
                aria-label={t('form.editFieldTitle', { field: t(`form.${editingField}`) })}
                className="w-full max-w-3xl rounded-xl border bg-background p-6 shadow-xl"
              >
                <header className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{t('form.editFieldTitle', { field: t(`form.${editingField}`) })}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{t('form.editFieldDescription')}</p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => closeFieldEditor(true)}
                    aria-label={t('actions.cancel')}
                    title={t('actions.cancel')}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </header>

                <div className="mt-4 max-h-[60vh] space-y-4 overflow-y-auto pr-1">
                  {editingField === 'defaultAction' && (
                    <div className="space-y-1">
                      <Label htmlFor="security-editor-default-action">{t('form.defaultAction')}</Label>
                      <Select
                        id="security-editor-default-action"
                        value={selectedPolicy.defaultAction}
                        onChange={(event) => updateSelectedPolicy({ defaultAction: event.target.value as SecurityAction })}
                      >
                        <option value="allow">{t('action.allow')}</option>
                        <option value="confirm">{t('action.confirm')}</option>
                        <option value="deny">{t('action.deny')}</option>
                      </Select>
                    </div>
                  )}

                  {editingField === 'confirmStrategy' && (
                    <div className="space-y-1">
                      <Label htmlFor="security-editor-confirm-strategy">{t('form.confirmStrategy')}</Label>
                      <Select
                        id="security-editor-confirm-strategy"
                        value={selectedPolicy.confirmStrategy}
                        onChange={(event) => updateSelectedPolicy({ confirmStrategy: event.target.value as ConfirmStrategy })}
                      >
                        <option value="every_time">{t('confirmStrategy.every_time')}</option>
                        <option value="session">{t('confirmStrategy.session')}</option>
                      </Select>
                    </div>
                  )}

                  {(editingField === 'allowCommandExecution' || editingField === 'allowDependencyInstall') && (
                    <div className="flex items-center justify-between rounded-md border p-3">
                      <Label htmlFor={`security-editor-switch-${editingField}`} className="cursor-pointer">
                        {t(`form.${editingField}`)}
                      </Label>
                      <Switch
                        id={`security-editor-switch-${editingField}`}
                        checked={selectedPolicy[editingField]}
                        onCheckedChange={(checked) => updateSelectedPolicy({ [editingField]: checked })}
                      />
                    </div>
                  )}

                  {(editingField === 'allowPathPrefixes' || editingField === 'allowDomains') && (
                    <div className="space-y-1">
                      <Label htmlFor={`security-editor-list-${editingField}`}>{t(`form.${editingField}`)}</Label>
                      <Textarea
                        id={`security-editor-list-${editingField}`}
                        value={formatToolListText(selectedPolicy[editingField])}
                        placeholder={editingField === 'allowPathPrefixes' ? t('form.pathPlaceholder') : t('form.domainPlaceholder')}
                        onChange={(event) => updateSelectedPolicy({ [editingField]: parseToolListText(event.target.value) })}
                        rows={4}
                      />
                    </div>
                  )}

                  {(editingField === 'allowTools' || editingField === 'confirmTools' || editingField === 'denyTools') && (
                    <div className="space-y-2">
                      <Label>{t('form.toolPolicyTitle')}</Label>
                      <p className="text-xs text-muted-foreground">{t('form.toolPolicyHint')}</p>
                      <div className="flex flex-wrap gap-2 rounded-md border p-3">
                        {toolOptions.map((toolName) => {
                          const selected = selectedPolicy[editingField].includes(toolName);
                          return (
                            <Button
                              key={`tool-editor-${editingField}-${toolName}`}
                              type="button"
                              size="sm"
                              variant={selected ? 'default' : 'outline'}
                              className={cn('h-7 px-2 text-xs', selected ? '' : 'text-muted-foreground')}
                              onClick={() => toggleToolInField(editingField, toolName)}
                              title={formatToolLabel(toolName) === toolName ? toolName : `${formatToolLabel(toolName)} (${toolName})`}
                            >
                              {formatToolLabel(toolName)}
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {editingField === 'capabilities' && (
                    <div className="space-y-2">
                      <Label>{t('form.capabilities')}</Label>
                      <p className="text-xs text-muted-foreground">{t('form.selectHint')}</p>
                      <div className="flex flex-wrap gap-2 rounded-md border p-3">
                        {CAPABILITY_OPTION_CATALOG.map((capability) => {
                          const selected = selectedPolicy.capabilities.includes(capability);
                          return (
                            <Button
                              key={`cap-editor-${capability}`}
                              type="button"
                              size="sm"
                              variant={selected ? 'default' : 'outline'}
                              className={cn('h-7 px-2 text-xs', selected ? '' : 'text-muted-foreground')}
                              onClick={() => toggleCapabilityValue(capability)}
                              title={formatCapabilityLabel(capability) === capability ? capability : `${formatCapabilityLabel(capability)} (${capability})`}
                            >
                              {formatCapabilityLabel(capability)}
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-5 flex flex-wrap justify-end gap-2 border-t pt-3">
                  <Button type="button" variant="outline" onClick={() => void handleUsePresetForField()} disabled={savingPolicies}>
                    {t('actions.usePreset')}
                  </Button>
                  <Button type="button" onClick={() => void handleSaveFieldEditor()} disabled={savingPolicies}>
                    {savingPolicies ? t('actions.saving') : t('actions.saveField')}
                  </Button>
                </div>
              </section>
            </div>
          )}

          <ConfirmDialog
            open={Boolean(toolConflict)}
            title={t('toolConflict.title')}
            message={toolConflict
              ? t('toolConflict.message', {
                tool: formatToolLabel(toolConflict.toolName),
                from: toolConflict.fromFields.map((field) => t(`form.${field}`)).join(' / '),
                to: t(`form.${toolConflict.targetField}`),
              })
              : ''}
            confirmLabel={t('toolConflict.confirm')}
            cancelLabel={t('toolConflict.cancel')}
            onConfirm={() => {
              if (!toolConflict) {
                return;
              }
              applyToolSelection(toolConflict.targetField, toolConflict.toolName);
              setToolConflict(null);
            }}
            onCancel={() => setToolConflict(null)}
          />

          </div>
        </>
      )}
    </section>
  );
}

export default SecurityPage;
