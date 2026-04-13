import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import {
  hostSecurityFetchRuleCatalog,
  hostSecurityReadAudit,
} from '@/lib/security-runtime';

export type AuditItem = {
  ts: number;
  toolName: string;
  risk: string;
  action: string;
  decision: string;
  ruleId?: string;
  detail?: string;
};

export type PlatformTool = {
  id: string;
  name?: string;
  source?: string;
  enabled?: boolean;
  description?: string;
  version?: string;
};

export type RemediationActionItem = {
  id: string;
  title: string;
  description: string;
  risk: string;
};

export type AllowlistRegexTab = 'allowlistTools' | 'allowlistSessions' | 'destructivePatterns' | 'secretPatterns';
export type RuleCatalogPlatform = 'all' | 'universal' | 'linux' | 'windows' | 'macos' | 'powershell';
export type SecuritySectionKey =
  | 'runtime'
  | 'matrix'
  | 'ruleCatalog'
  | 'allowlistRegex'
  | 'policyGuards'
  | 'actionCenter'
  | 'auditHits';

export type RuleCatalogItem = {
  platform: Exclude<RuleCatalogPlatform, 'all'>;
  command: string;
  category: string;
  severity: string;
  reason: string;
};

let securityPlatformToolsCache: PlatformTool[] = [];
let securityPlatformToolsHydratedCache = false;
let securityRuleCatalogCache: RuleCatalogItem[] = [];
let securityAuditItemsCache: AuditItem[] = [];

function clonePlatformTools(tools: PlatformTool[]): PlatformTool[] {
  return tools.map((tool) => ({ ...tool }));
}

function cloneRuleCatalog(items: RuleCatalogItem[]): RuleCatalogItem[] {
  return items.map((item) => ({ ...item }));
}

function cloneAuditItems(items: AuditItem[]): AuditItem[] {
  return items.map((item) => ({ ...item }));
}

interface SecuritySupportState {
  auditItems: AuditItem[];
  loadingAudit: boolean;
  platformTools: PlatformTool[];
  loadingPlatformTools: boolean;
  platformToolsError: string | null;
  platformToolsHydrated: boolean;
  ruleCatalog: RuleCatalogItem[];
  loadingRuleCatalog: boolean;
  ruleCatalogError: string | null;
  securityOpBusy: string | null;
  securityOpResult: string;
  remediationActions: RemediationActionItem[];
  selectedRemediationActions: string[];
  lastRemediationSnapshotId: string | null;
  allowlistRegexTab: AllowlistRegexTab;
  ruleCatalogPlatform: RuleCatalogPlatform;
  activeSection: SecuritySectionKey;
  setSecurityOpBusy: (name: string | null) => void;
  setSecurityOpResult: (text: string) => void;
  setRemediationActions: (actions: RemediationActionItem[]) => void;
  setSelectedRemediationActions: (next: string[] | ((prev: string[]) => string[])) => void;
  setLastRemediationSnapshotId: (snapshotId: string | null) => void;
  setAllowlistRegexTab: (tab: AllowlistRegexTab) => void;
  setRuleCatalogPlatform: (platform: RuleCatalogPlatform) => void;
  setActiveSection: (section: SecuritySectionKey) => void;
  loadPlatformTools: (options?: { refresh?: boolean }) => Promise<void>;
  loadRuleCatalog: () => Promise<void>;
  loadRecentAudits: (options?: { gatewayState?: string; page?: number; pageSize?: number }) => Promise<void>;
}

export const useSecuritySupportStore = create<SecuritySupportState>((set) => ({
  auditItems: cloneAuditItems(securityAuditItemsCache),
  loadingAudit: false,
  platformTools: clonePlatformTools(securityPlatformToolsCache),
  loadingPlatformTools: false,
  platformToolsError: null,
  platformToolsHydrated: securityPlatformToolsHydratedCache,
  ruleCatalog: cloneRuleCatalog(securityRuleCatalogCache),
  loadingRuleCatalog: false,
  ruleCatalogError: null,
  securityOpBusy: null,
  securityOpResult: '',
  remediationActions: [],
  selectedRemediationActions: [],
  lastRemediationSnapshotId: null,
  allowlistRegexTab: 'allowlistTools',
  ruleCatalogPlatform: 'all',
  activeSection: 'runtime',

  setSecurityOpBusy: (name) => set((state) => (
    state.securityOpBusy === name
      ? state
      : { securityOpBusy: name }
  )),

  setSecurityOpResult: (text) => set((state) => (
    state.securityOpResult === text
      ? state
      : { securityOpResult: text }
  )),

  setRemediationActions: (actions) => set(() => ({
    remediationActions: actions,
    selectedRemediationActions: actions.map((item) => item.id),
  })),

  setSelectedRemediationActions: (next) => set((state) => {
    const resolved = typeof next === 'function' ? next(state.selectedRemediationActions) : next;
    const normalized = Array.from(new Set(
      (Array.isArray(resolved) ? resolved : [])
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ));
    return {
      selectedRemediationActions: normalized,
    };
  }),

  setLastRemediationSnapshotId: (snapshotId) => set((state) => (
    state.lastRemediationSnapshotId === snapshotId
      ? state
      : { lastRemediationSnapshotId: snapshotId }
  )),

  setAllowlistRegexTab: (tab) => set((state) => (
    state.allowlistRegexTab === tab
      ? state
      : { allowlistRegexTab: tab }
  )),

  setRuleCatalogPlatform: (platform) => set((state) => (
    state.ruleCatalogPlatform === platform
      ? state
      : { ruleCatalogPlatform: platform }
  )),

  setActiveSection: (section) => set((state) => (
    state.activeSection === section
      ? state
      : { activeSection: section }
  )),

  loadPlatformTools: async (options) => {
    const refresh = options?.refresh === true;
    set({
      loadingPlatformTools: true,
      platformToolsHydrated: true,
    });
    securityPlatformToolsHydratedCache = true;
    try {
      const payload = await hostApiFetch<{ success?: boolean; tools?: PlatformTool[] }>(
        `/api/platform/tools?includeDisabled=true&refresh=${refresh ? 'true' : 'false'}`,
      );
      const tools = Array.isArray(payload?.tools) ? payload.tools : [];
      const normalized = tools
        .filter((tool): tool is PlatformTool => Boolean(tool && typeof tool.id === 'string' && tool.id.trim().length > 0))
        .map((tool) => ({
          id: tool.id.trim(),
          name: typeof tool.name === 'string' ? tool.name : undefined,
          source: typeof tool.source === 'string' ? tool.source : undefined,
          enabled: typeof tool.enabled === 'boolean' ? tool.enabled : undefined,
          description: typeof tool.description === 'string' ? tool.description : undefined,
          version: typeof tool.version === 'string' ? tool.version : undefined,
        }))
        .sort((a, b) => {
          const enabledRankA = a.enabled === false ? 1 : 0;
          const enabledRankB = b.enabled === false ? 1 : 0;
          if (enabledRankA !== enabledRankB) return enabledRankA - enabledRankB;
          return a.id.localeCompare(b.id);
        });
      securityPlatformToolsCache = clonePlatformTools(normalized);
      set({
        platformTools: normalized,
        platformToolsError: null,
      });
    } catch (error) {
      set({
        platformToolsError: error instanceof Error ? error.message : 'errors.loadToolsFailed',
      });
    } finally {
      set({ loadingPlatformTools: false });
    }
  },

  loadRuleCatalog: async () => {
    set({ loadingRuleCatalog: true });
    try {
      const payload = await hostSecurityFetchRuleCatalog<{ success?: boolean; items?: RuleCatalogItem[] }>();
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const allowedPlatforms = new Set<Exclude<RuleCatalogPlatform, 'all'>>(['universal', 'linux', 'windows', 'macos', 'powershell']);
      const normalized = items.filter((item): item is RuleCatalogItem => {
        if (!item || typeof item !== 'object') return false;
        if (!item.platform || typeof item.platform !== 'string' || !allowedPlatforms.has(item.platform as Exclude<RuleCatalogPlatform, 'all'>)) return false;
        if (!item.command || typeof item.command !== 'string') return false;
        if (!item.category || typeof item.category !== 'string') return false;
        if (!item.severity || typeof item.severity !== 'string') return false;
        return typeof item.reason === 'string';
      });
      securityRuleCatalogCache = cloneRuleCatalog(normalized);
      set({
        ruleCatalog: normalized,
        ruleCatalogError: null,
      });
    } catch (error) {
      set({
        ruleCatalogError: error instanceof Error ? error.message : 'errors.loadRuleCatalogFailed',
      });
    } finally {
      set({ loadingRuleCatalog: false });
    }
  },

  loadRecentAudits: async (options) => {
    const gatewayState = options?.gatewayState;
    if (gatewayState && gatewayState !== 'running') {
      return;
    }
    const page = options?.page ?? 1;
    const pageSize = options?.pageSize ?? 8;
    set({ loadingAudit: true });
    try {
      const result = await hostSecurityReadAudit<{ items?: AuditItem[] }>({ page, pageSize });
      const nextItems = Array.isArray(result.items) ? result.items : [];
      securityAuditItemsCache = cloneAuditItems(nextItems);
      set({ auditItems: nextItems });
    } catch {
      // Keep stale audit data on refresh failure.
    } finally {
      set({ loadingAudit: false });
    }
  },
}));
