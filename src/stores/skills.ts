/**
 * Skills State Store
 * Manages skill/plugin state
 */
import { create } from 'zustand';
import { buildCapabilityScopeKey, runtimeScopeQuery, type RuntimeScope } from '@/types/desktop/runtime-address';
import {
  hostApiFetch,
} from '@/lib/host-api';
import { AppError, normalizeAppError } from '@/lib/error-model';
import { hostSkillsMutation, waitForSkillsOperation, selectedSkillsScope, requireSkillsScope } from '@/lib/skills';
import type { SkillsBatchStateResult } from '@/types/skills-operation-result';
import type { Skill, MarketplaceSkill, SkillMissingCategory, SkillMissingRequirements, SkillUnavailableReason } from '../types/skill';
import type { CapabilityTarget } from '../types/desktop/capability-target';
import type { LocalSkillImportPayload } from '@/services/local-path-picker';

type GatewaySkillMissing = {
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  config?: string[];
  os?: string[];
};

type GatewaySkillStatus = {
  skillKey: string;
  slug?: string;
  name?: string;
  description?: string;
  disabled?: boolean;
  selectable?: boolean;
  unavailableReason?: SkillUnavailableReason | null;
  missingCategories?: SkillMissingCategory[];
  emoji?: string;
  version?: string;
  author?: string;
  bundled?: boolean;
  always?: boolean;
  uninstallable?: boolean;
  eligible?: boolean;
  missing?: GatewaySkillMissing;
  source?: string;
  baseDir?: string;
  filePath?: string;
};

type GatewaySkillsStatusResult = {
  skills?: GatewaySkillStatus[];
  ready?: boolean;
  refreshing?: boolean;
  updatedAt?: number | null;
  error?: string | null;
};

type MarketplaceSearchResult = {
  success: boolean;
  results?: MarketplaceSkill[];
  error?: string;
};

const SKILL_MANAGEMENT_CAPABILITY_ID = 'skill.management';
const MARKETPLACE_SEARCH_CACHE_TTL_MS = 2500;
const SKILLS_FETCH_MIN_INTERVAL_MS = 30000;
const SKILLS_SNAPSHOT_NOT_READY_RETRY_MS = 1200;
const marketplaceSearchCache = new Map<string, {
  timestamp: number;
  results: MarketplaceSkill[];
}>();
const inflightMarketplaceSearch = new Map<string, Promise<MarketplaceSearchResult>>();
let currentMarketplaceQuery = { key: '' };
let inflightSkillsFetch: Promise<void> | null = null;
let lastSkillsFetchAt = 0;
let skillsSnapshotRetryTimer: ReturnType<typeof setTimeout> | null = null;

function clearSkillsSnapshotRetry(): void {
  if (skillsSnapshotRetryTimer) {
    clearTimeout(skillsSnapshotRetryTimer);
    skillsSnapshotRetryTimer = null;
  }
}

function scheduleSkillsSnapshotRetry(fetchSkills: () => Promise<void>): void {
  if (skillsSnapshotRetryTimer) {
    return;
  }
  skillsSnapshotRetryTimer = setTimeout(() => {
    skillsSnapshotRetryTimer = null;
    void fetchSkills();
  }, SKILLS_SNAPSHOT_NOT_READY_RETRY_MS);
}

function normalizeMissingRequirements(missing?: GatewaySkillMissing): SkillMissingRequirements | undefined {
  if (!missing) {
    return undefined;
  }

  const normalized: SkillMissingRequirements = {
    bins: Array.isArray(missing.bins) ? missing.bins : [],
    anyBins: Array.isArray(missing.anyBins) ? missing.anyBins : [],
    env: Array.isArray(missing.env) ? missing.env : [],
    config: Array.isArray(missing.config) ? missing.config : [],
    os: Array.isArray(missing.os) ? missing.os : [],
  };

  const hasMissing = Object.values(normalized).some((items) => Array.isArray(items) && items.length > 0);
  return hasMissing ? normalized : undefined;
}

function mapErrorCodeToSkillErrorKey(
  code: AppError['code'],
  operation: 'fetch' | 'search' | 'install',
): string | null {
  if (code === 'TIMEOUT') {
    return operation === 'search'
      ? 'searchTimeoutError'
      : operation === 'install'
        ? 'installTimeoutError'
        : 'fetchTimeoutError';
  }
  if (code === 'RATE_LIMIT') {
    return operation === 'search'
      ? 'searchRateLimitError'
      : operation === 'install'
        ? 'installRateLimitError'
        : 'fetchRateLimitError';
  }
  return null;
}

async function skillManagementCapabilityExecute<TResult>(
  operationId: string,
  input: Record<string, unknown>,
  target: CapabilityTarget,
  scope: RuntimeScope,
): Promise<TResult> {
  return await hostApiFetch<TResult>('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify({
      id: SKILL_MANAGEMENT_CAPABILITY_ID,
      operationId,
      scope,
      target,
      input,
    }),
  });
}

function hasMutatingSkills(mutatingBySkillId: Record<string, number>): boolean {
  return Object.keys(mutatingBySkillId).length > 0;
}

function incrementMutatingSkill(
  mutatingBySkillId: Record<string, number>,
  skillId: string,
): Record<string, number> {
  const current = mutatingBySkillId[skillId] ?? 0;
  return {
    ...mutatingBySkillId,
    [skillId]: current + 1,
  };
}

function decrementMutatingSkill(
  mutatingBySkillId: Record<string, number>,
  skillId: string,
): Record<string, number> {
  const current = mutatingBySkillId[skillId] ?? 0;
  if (current <= 1) {
    const next = { ...mutatingBySkillId };
    delete next[skillId];
    return next;
  }
  return {
    ...mutatingBySkillId,
    [skillId]: current - 1,
  };
}

function scopedState(scope: RuntimeScope, followSelection = true) {
  const key = buildCapabilityScopeKey(scope);
  useSkillsStore.getState().setScope(scope);
  const generation = useSkillsStore.getState().scopeGeneration;
  const current = () => {
    const selected = selectedSkillsScope();
    return (!followSelection || Boolean(selected && buildCapabilityScopeKey(selected) === key))
      && useSkillsStore.getState().scopeGeneration === generation;
  };
  const set = (partial: Partial<SkillsState> | ((state: SkillsState) => Partial<SkillsState>)) => {
    if (current()) useSkillsStore.setState(partial);
  };
  return { set, current };
}

async function enableSkillConfig(skillId: string, scope: RuntimeScope, current: () => boolean): Promise<void> {
  const result = await hostSkillsMutation('/api/skills/config', { skillKey: skillId, enabled: true, scope }, 'skills.config');
  if (result.outcome !== 'accepted') throw new Error('Failed to enable skill');
  if (!current()) return;
  const state = useSkillsStore.getState();
  const skill = state.skills.find((entry) => entry.id === skillId);
  if (skill) {
    state.updateSkill(skillId, {
      enabled: true,
      ...(skill.unavailableReason === 'disabled' ? { unavailableReason: null } : {}),
    });
  }
}

interface SkillsState {
  scopeKey: string | null;
  scopeGeneration: number;
  setScope: (scope: RuntimeScope | null) => void;
  skills: Skill[];
  searchResults: MarketplaceSkill[];
  snapshotReady: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  mutating: boolean;
  mutatingBySkillId: Record<string, number>;
  searching: boolean;
  searchError: string | null;
  installing: Record<string, boolean>; // slug -> boolean
  error: string | null;

  // Actions
  fetchSkills: (options?: { force?: boolean; silent?: boolean; fresh?: boolean; scope?: RuntimeScope }) => Promise<void>;
  setSearchQuery: (query: string) => void;
  searchSkills: (query: string) => Promise<void>;
  installSkill: (slug: string, version?: string, scope?: RuntimeScope) => Promise<void>;
  importLocalSkill: (payload: LocalSkillImportPayload, scope?: RuntimeScope) => Promise<string>;
  finishSkillInstallation: (skillId: string, scope: RuntimeScope, current: () => boolean) => Promise<void>;
  uninstallSkill: (skillKey: string, slug?: string) => Promise<void>;
  enableSkill: (skillId: string, scope?: RuntimeScope) => Promise<void>;
  disableSkill: (skillId: string) => Promise<void>;
  batchSetSkillsEnabled: (skillIds: string[], enabled: boolean) => Promise<SkillsBatchStateResult>;
  setSkills: (skills: Skill[]) => void;
  updateSkill: (skillId: string, updates: Partial<Skill>) => void;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  scopeKey: null,
  scopeGeneration: 0,
  setScope: (scope) => {
    const key = scope ? buildCapabilityScopeKey(scope) : null;
    if (get().scopeKey === key) return;
    clearSkillsSnapshotRetry();
    inflightSkillsFetch = null;
    lastSkillsFetchAt = 0;
    set({ scopeKey: key, scopeGeneration: get().scopeGeneration + 1, skills: [], snapshotReady: false,
      initialLoading: false, refreshing: false, mutating: false, mutatingBySkillId: {}, installing: {}, error: null });
  },
  skills: [],
  searchResults: [],
  snapshotReady: false,
  initialLoading: false,
  refreshing: false,
  mutating: false,
  mutatingBySkillId: {},
  searching: false,
  searchError: null,
  installing: {},
  error: null,

  fetchSkills: async (options) => {
    const scope = options?.scope ?? selectedSkillsScope();
    if (!scope) { get().setScope(null); return; }
    const { set, current } = scopedState(scope, !options?.scope);
    const generation = get().scopeGeneration;
    const force = options?.force === true;
    const silent = options?.silent === true;
    const fresh = options?.fresh === true;
    const now = Date.now();
    const hasSnapshot = get().snapshotReady;

    if (inflightSkillsFetch) {
      await inflightSkillsFetch;
      if (force || fresh) {
        if (current()) await get().fetchSkills({ force: true, silent, fresh, scope: options?.scope });
      }
      return;
    }
    if (!force && hasSnapshot && now - lastSkillsFetchAt < SKILLS_FETCH_MIN_INTERVAL_MS) {
      return;
    }

    if (!hasSnapshot) {
      set({
        initialLoading: true,
        refreshing: false,
        error: null,
      });
    } else if (!silent) {
      set({
        refreshing: true,
        initialLoading: false,
        error: null,
      });
    } else {
      set({
        refreshing: false,
        initialLoading: false,
        error: null,
      });
    }

    inflightSkillsFetch = (async () => {
      try {
        const gatewayPromise = fresh
          ? skillManagementCapabilityExecute<GatewaySkillsStatusResult>(
            'skills.refreshStatus',
            {},
            { kind: 'none' },
            scope,
          )
          : hostApiFetch<GatewaySkillsStatusResult>(`/api/skills/status?${runtimeScopeQuery(scope)}`);
        const gatewayData = await gatewayPromise;
        if (!current()) return;

        let combinedSkills: Skill[] = [];
        const currentSkills = get().skills;

        if (gatewayData.ready === false) {
          set((state) => ({
            ...state,
            snapshotReady: state.snapshotReady,
            initialLoading: !state.snapshotReady,
            refreshing: true,
            error: gatewayData.error ?? null,
          }));
          scheduleSkillsSnapshotRetry(() => current() ? get().fetchSkills({ force: true, silent: true, scope: options?.scope }) : Promise.resolve());
          return;
        }

        clearSkillsSnapshotRetry();

        // Map gateway skills info
        if (gatewayData.skills) {
          combinedSkills = gatewayData.skills.map((s: GatewaySkillStatus) => {
            return {
              id: s.skillKey,
              runtimeId: scope.kind === 'agent' ? 'matcha-agent' : 'openclaw',
              slug: s.slug,
              name: s.name || s.skillKey,
              description: s.description || '',
              enabled: !s.disabled,
              icon: s.emoji || '📦',
              version: s.version || (scope.kind === 'agent' ? undefined : '1.0.0'),
              author: s.author,
              selectable: typeof s.selectable === 'boolean' ? s.selectable : undefined,
              eligible: typeof s.eligible === 'boolean' ? s.eligible : undefined,
              unavailableReason: s.unavailableReason ?? null,
              missingCategories: Array.isArray(s.missingCategories) ? s.missingCategories : undefined,
              missing: normalizeMissingRequirements(s.missing),
              config: {},
              isCore: s.bundled && s.always,
              isBundled: s.bundled,
              uninstallable: s.uninstallable === true,
              source: s.source,
              baseDir: s.baseDir,
              filePath: s.filePath,
            };
          });
        } else if (currentSkills.length > 0) {
          // ... if gateway down ...
          combinedSkills = [...currentSkills];
        }

        lastSkillsFetchAt = Date.now();
        set({
          skills: combinedSkills,
          snapshotReady: true,
          initialLoading: false,
          refreshing: false,
          error: null,
        });
      } catch (error) {
        console.error('Failed to fetch skills:', error);
        if (silent && hasSnapshot) {
          set({
            initialLoading: false,
            refreshing: false,
          });
          return;
        }
        const appError = normalizeAppError(error, { module: 'skills', operation: 'fetch' });
        const errorKey = mapErrorCodeToSkillErrorKey(appError.code, 'fetch');
        set({
          initialLoading: false,
          refreshing: false,
          error: errorKey ?? appError.message,
        });
      } finally {
        if (get().scopeGeneration === generation) inflightSkillsFetch = null;
      }
    })();

    await inflightSkillsFetch;
  },

  setSearchQuery: (query) => {
    const key = query.trim().toLowerCase();
    if (currentMarketplaceQuery.key === key) return;
    currentMarketplaceQuery = { key };
    set({ searching: false, searchError: null });
  },

  searchSkills: async (query: string) => {
    const normalizedQuery = query.trim();
    const cacheKey = normalizedQuery.toLowerCase();
    const request = { key: cacheKey };
    currentMarketplaceQuery = request;
    const setSearch = (state: Partial<SkillsState>) => {
      if (currentMarketplaceQuery === request) set(state);
    };
    const now = Date.now();
    const cached = marketplaceSearchCache.get(cacheKey);
    if (cached && now - cached.timestamp < MARKETPLACE_SEARCH_CACHE_TTL_MS) {
      setSearch({ searchResults: cached.results, searching: false, searchError: null });
      return;
    }

    setSearch({ searching: true, searchError: null });
    let pending = inflightMarketplaceSearch.get(cacheKey);
    if (!pending) {
      pending = hostApiFetch<MarketplaceSearchResult>('/api/clawhub/search', {
        method: 'POST',
        body: JSON.stringify({ query: normalizedQuery }),
      });
      inflightMarketplaceSearch.set(cacheKey, pending);
    }

    try {
      const result = await pending;
      if (result.success) {
        const results = result.results || [];
        marketplaceSearchCache.set(cacheKey, { timestamp: Date.now(), results });
        setSearch({ searchResults: results });
      } else {
        throw normalizeAppError(new Error(result.error || 'Search failed'), {
          module: 'skills',
          operation: 'search',
        });
      }
    } catch (error) {
      const appError = normalizeAppError(error, { module: 'skills', operation: 'search' });
      const errorKey = mapErrorCodeToSkillErrorKey(appError.code, 'search');
      setSearch({ searchError: errorKey ?? appError.message });
    } finally {
      if (inflightMarketplaceSearch.get(cacheKey) === pending) {
        inflightMarketplaceSearch.delete(cacheKey);
      }
      setSearch({ searching: false });
    }
  },

  installSkill: async (slug, version, sourceScope) => {
    const scope = sourceScope ?? requireSkillsScope();
    const { set, current } = scopedState(scope, !sourceScope);
    if (get().installing[slug]) {
      return;
    }
    set((state) => {
      const nextMutating = incrementMutatingSkill(state.mutatingBySkillId, slug);
      return {
        installing: { ...state.installing, [slug]: true },
        mutatingBySkillId: nextMutating,
        mutating: true,
      };
    });
    try {
      const result = await hostSkillsMutation('/api/skills/clawhub/install',
        { slug, ...(version ? { version } : {}), scope }, 'skills.clawhub.install', { timeoutMs: null });
      if (result.outcome !== 'accepted') {
        const appError = normalizeAppError(new Error('Install failed'), {
          module: 'skills',
          operation: 'install',
        });
        const errorKey = mapErrorCodeToSkillErrorKey(appError.code, 'install');
        throw new Error(errorKey ?? appError.message);
      }
      if (!current()) return;
      await get().finishSkillInstallation(slug, scope, current);
    } catch (error) {
      console.error('Install error:', error);
      throw error;
    } finally {
      set((state) => {
        const newInstalling = { ...state.installing };
        delete newInstalling[slug];
        const nextMutating = decrementMutatingSkill(state.mutatingBySkillId, slug);
        return {
          installing: newInstalling,
          mutatingBySkillId: nextMutating,
          mutating: hasMutatingSkills(nextMutating),
        };
      });
    }
  },

  importLocalSkill: async (payload, sourceScope) => {
    const scope = sourceScope ?? requireSkillsScope();
    const { set } = scopedState(scope, !sourceScope);
    const skillKey = scope.kind === 'agent' ? payload.skillKey.trim().toLowerCase().replace(/-+/g, '-') : payload.skillKey.trim();
    if (!skillKey) {
      throw new Error('Imported skill key is required');
    }
    if (get().installing[skillKey]) {
      return skillKey;
    }
    set((state) => {
      const nextMutating = incrementMutatingSkill(state.mutatingBySkillId, skillKey);
      return {
        installing: { ...state.installing, [skillKey]: true },
        mutatingBySkillId: nextMutating,
        mutating: true,
      };
    });
    try {
      const markdown = payload.kind === 'markdown' && scope.kind !== 'agent';
      const endpoint = markdown ? '/api/skills/import/markdown' : '/api/skills/import/bundle';
      const body = payload.kind === 'markdown'
        ? markdown ? { content: payload.content } : { skillKey, files: [{ path: 'SKILL.md', content: payload.content }] }
        : { skillKey, files: payload.files };
      const result = await hostSkillsMutation(endpoint, { ...body, scope },
        markdown ? 'skills.import.markdown' : 'skills.import.bundle', { timeoutMs: null });
      if (result.outcome !== 'accepted') {
        throw new Error('Skill import failed');
      }
      return skillKey;
    } finally {
      set((state) => {
        const newInstalling = { ...state.installing };
        delete newInstalling[skillKey];
        const nextMutating = decrementMutatingSkill(state.mutatingBySkillId, skillKey);
        return {
          installing: newInstalling,
          mutatingBySkillId: nextMutating,
          mutating: hasMutatingSkills(nextMutating),
        };
      });
    }
  },

  finishSkillInstallation: async (skillId, scope, installationCurrent) => {
    const { set, current } = scopedState(scope, false);
    if (scope.kind === 'runtime-instance' && scope.endpoint.kind === 'native-runtime'
      && scope.endpoint.runtimeAdapterId === 'openclaw') {
      set((state) => ({
        mutatingBySkillId: incrementMutatingSkill(state.mutatingBySkillId, skillId),
        mutating: true,
      }));
      try {
        await enableSkillConfig(skillId, scope, current);
      } finally {
        set((state) => {
          const nextMutating = decrementMutatingSkill(state.mutatingBySkillId, skillId);
          return { mutatingBySkillId: nextMutating, mutating: hasMutatingSkills(nextMutating) };
        });
      }
    }
    if (installationCurrent()) await get().fetchSkills({ force: true, fresh: true, scope });
  },

  uninstallSkill: async (skillKey: string, slug?: string) => {
    const scope = requireSkillsScope();
    const { set, current } = scopedState(scope);
    set((state) => {
      const nextMutating = incrementMutatingSkill(state.mutatingBySkillId, skillKey);
      return {
        installing: { ...state.installing, [skillKey]: true },
        mutatingBySkillId: nextMutating,
        mutating: true,
      };
    });
    try {
      const result = await hostSkillsMutation('/api/skills/uninstall', { skillKey, ...(slug ? { slug } : {}), scope }, 'skills.uninstall');
      if (result.outcome !== 'removed') {
        throw new Error('Uninstall failed');
      }
      set((state) => ({
        skills: state.skills.filter((skill) =>
          skill.id !== skillKey && (!slug || skill.slug !== slug)
        ),
      }));
      if (current()) void get().fetchSkills({ force: true, silent: true, fresh: true, scope });
    } catch (error) {
      console.error('Uninstall error:', error);
      throw error;
    } finally {
      set((state) => {
        const newInstalling = { ...state.installing };
        delete newInstalling[skillKey];
        const nextMutating = decrementMutatingSkill(state.mutatingBySkillId, skillKey);
        return {
          installing: newInstalling,
          mutatingBySkillId: nextMutating,
          mutating: hasMutatingSkills(nextMutating),
        };
      });
    }
  },

  enableSkill: async (skillId, sourceScope) => {
    const scope = sourceScope ?? requireSkillsScope();
    if (scope.kind !== 'runtime-instance') throw new Error('This runtime has no per-skill enable switch');
    const { set, current } = scopedState(scope, !sourceScope);
    set((state) => {
      const nextMutating = incrementMutatingSkill(state.mutatingBySkillId, skillId);
      return {
        mutatingBySkillId: nextMutating,
        mutating: true,
      };
    });

    try {
      await enableSkillConfig(skillId, scope, current);
      if (current() && !get().skills.some((skill) => skill.id === skillId)) {
        await get().fetchSkills({ force: true, silent: true, fresh: true, scope });
      }
    } catch (error) {
      console.error('Failed to enable skill:', error);
      throw error;
    } finally {
      set((state) => {
        const nextMutating = decrementMutatingSkill(state.mutatingBySkillId, skillId);
        return {
          mutatingBySkillId: nextMutating,
          mutating: hasMutatingSkills(nextMutating),
        };
      });
    }
  },

  disableSkill: async (skillId) => {
    const scope = requireSkillsScope();
    if (scope.kind !== 'runtime-instance') throw new Error('This runtime has no per-skill enable switch');
    const { set, current } = scopedState(scope);
    const { updateSkill, skills } = get();

    const skill = skills.find((s) => s.id === skillId);
    if (skill?.isCore) {
      throw new Error('Cannot disable core skill');
    }
    set((state) => {
      const nextMutating = incrementMutatingSkill(state.mutatingBySkillId, skillId);
      return {
        mutatingBySkillId: nextMutating,
        mutating: true,
      };
    });

    try {
      const result = await hostSkillsMutation('/api/skills/config', { skillKey: skillId, enabled: false, scope }, 'skills.config');
      if (result.outcome !== 'accepted') {
        throw new Error('Failed to disable skill');
      }
      if (!current()) return;
      if (skill) {
        updateSkill(skillId, { enabled: false });
      } else {
        await get().fetchSkills({ force: true, silent: true, fresh: true, scope });
      }
    } catch (error) {
      console.error('Failed to disable skill:', error);
      throw error;
    } finally {
      set((state) => {
        const nextMutating = decrementMutatingSkill(state.mutatingBySkillId, skillId);
        return {
          mutatingBySkillId: nextMutating,
          mutating: hasMutatingSkills(nextMutating),
        };
      });
    }
  },

  batchSetSkillsEnabled: async (skillIds, enabled) => {
    const scope = requireSkillsScope();
    if (scope.kind !== 'runtime-instance') throw new Error('This runtime has no per-skill enable switch');
    const { set } = scopedState(scope);
    const uniqueSkillIds = [...new Set(skillIds.map((skillId) => skillId.trim()).filter(Boolean))];
    if (uniqueSkillIds.length === 0) {
      return { kind: 'batchState', success: true, outcome: 'accepted', enabled, requested: [], updated: [], invalidKeys: [], failed: [] };
    }
    const { skills } = get();
    if (!enabled) {
      const coreSkill = skills.find((skill) => uniqueSkillIds.includes(skill.id) && skill.isCore);
      if (coreSkill) {
        throw new Error('Cannot disable core skill');
      }
    }

    set((state) => {
      let nextMutating = state.mutatingBySkillId;
      for (const skillId of uniqueSkillIds) {
        nextMutating = incrementMutatingSkill(nextMutating, skillId);
      }
      return {
        mutatingBySkillId: nextMutating,
        mutating: true,
      };
    });

    try {
      const input = { skillKeys: uniqueSkillIds, enabled };
      const receipt = await skillManagementCapabilityExecute<unknown>('skills.updateBatchState', input, { kind: 'skill' }, scope);
      const result = await waitForSkillsOperation(receipt, 'skills.updateBatchState', { ...input, scope });
      if (result.kind !== 'batchState') throw new Error('Invalid Skills batch result');
      const updatedSkillIdSet = new Set(result.updated);
      set((state) => ({
        skills: state.skills.map((skill) =>
          updatedSkillIdSet.has(skill.id)
            ? { ...skill, enabled }
            : skill
        ),
      }));
      return result;
    } catch (error) {
      console.error('Failed to batch update skills:', error);
      throw error;
    } finally {
      set((state) => {
        let nextMutating = state.mutatingBySkillId;
        for (const skillId of uniqueSkillIds) {
          nextMutating = decrementMutatingSkill(nextMutating, skillId);
        }
        return {
          mutatingBySkillId: nextMutating,
          mutating: hasMutatingSkills(nextMutating),
        };
      });
    }
  },

  setSkills: (skills) => set({
    skills,
    snapshotReady: true,
    initialLoading: false,
    refreshing: false,
  }),

  updateSkill: (skillId, updates) => {
    set((state) => ({
      skills: state.skills.map((skill) =>
        skill.id === skillId ? { ...skill, ...updates } : skill
      ),
    }));
  },
}));
