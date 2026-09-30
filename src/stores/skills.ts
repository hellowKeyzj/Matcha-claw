/**
 * Skills State Store
 * Manages skill/plugin state
 */
import { create } from 'zustand';
import {
  hostApiFetch,
  resolveSingleCapabilityScope,
} from '@/lib/host-api';
import { AppError, normalizeAppError } from '@/lib/error-model';
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

type SkillsMutationResponse = {
  outcome: 'accepted' | 'rejected' | 'unknown';
};

type SkillsUninstallResponse = {
  outcome: 'removed' | 'notFound' | 'rejected' | 'unknown';
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
): Promise<TResult> {
  return await hostApiFetch<TResult>('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify({
      id: SKILL_MANAGEMENT_CAPABILITY_ID,
      operationId,
      scope: await resolveSingleCapabilityScope(SKILL_MANAGEMENT_CAPABILITY_ID),
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

interface SkillsState {
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
  fetchSkills: (options?: { force?: boolean; silent?: boolean; fresh?: boolean }) => Promise<void>;
  searchSkills: (query: string) => Promise<void>;
  installSkill: (slug: string, version?: string) => Promise<void>;
  importLocalSkill: (payload: LocalSkillImportPayload) => Promise<string>;
  uninstallSkill: (skillKey: string, slug?: string) => Promise<void>;
  enableSkill: (skillId: string) => Promise<void>;
  disableSkill: (skillId: string) => Promise<void>;
  batchSetSkillsEnabled: (skillIds: string[], enabled: boolean) => Promise<void>;
  setSkills: (skills: Skill[]) => void;
  updateSkill: (skillId: string, updates: Partial<Skill>) => void;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
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
    const force = options?.force === true;
    const silent = options?.silent === true;
    const fresh = options?.fresh === true;
    const now = Date.now();
    const hasSnapshot = get().snapshotReady;

    if (inflightSkillsFetch) {
      await inflightSkillsFetch;
      if (force || fresh) {
        await get().fetchSkills({ force: true, silent, fresh });
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
          )
          : hostApiFetch<GatewaySkillsStatusResult>('/api/skills/status');
        const gatewayData = await gatewayPromise;

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
          scheduleSkillsSnapshotRetry(() => get().fetchSkills({ force: true, silent: true }));
          return;
        }

        clearSkillsSnapshotRetry();

        // Map gateway skills info
        if (gatewayData.skills) {
          combinedSkills = gatewayData.skills.map((s: GatewaySkillStatus) => {
            return {
              id: s.skillKey,
              runtimeId: 'openclaw',
              slug: s.slug,
              name: s.name || s.skillKey,
              description: s.description || '',
              enabled: !s.disabled,
              icon: s.emoji || '📦',
              version: s.version || '1.0.0',
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
        inflightSkillsFetch = null;
      }
    })();

    await inflightSkillsFetch;
  },

  searchSkills: async (query: string) => {
    const normalizedQuery = query.trim();
    const cacheKey = normalizedQuery.toLowerCase();
    const now = Date.now();
    const cached = marketplaceSearchCache.get(cacheKey);
    if (cached && now - cached.timestamp < MARKETPLACE_SEARCH_CACHE_TTL_MS) {
      set({ searchResults: cached.results, searching: false, searchError: null });
      return;
    }

    set({ searching: true, searchError: null });
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
        set({ searchResults: results });
      } else {
        throw normalizeAppError(new Error(result.error || 'Search failed'), {
          module: 'skills',
          operation: 'search',
        });
      }
    } catch (error) {
      const appError = normalizeAppError(error, { module: 'skills', operation: 'search' });
      const errorKey = mapErrorCodeToSkillErrorKey(appError.code, 'search');
      set({ searchError: errorKey ?? appError.message });
    } finally {
      if (inflightMarketplaceSearch.get(cacheKey) === pending) {
        inflightMarketplaceSearch.delete(cacheKey);
      }
      set({ searching: false });
    }
  },

  installSkill: async (slug: string, version?: string) => {
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
      const result = await hostApiFetch<SkillsMutationResponse>('/api/skills/clawhub/install', {
        method: 'POST',
        body: JSON.stringify({ slug, ...(version ? { version } : {}) }),
      });
      if (result.outcome !== 'accepted') {
        const appError = normalizeAppError(new Error('Install failed'), {
          module: 'skills',
          operation: 'install',
        });
        const errorKey = mapErrorCodeToSkillErrorKey(appError.code, 'install');
        throw new Error(errorKey ?? appError.message);
      }
      await get().enableSkill(slug);
      await get().fetchSkills({ force: true, fresh: true });
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

  importLocalSkill: async (payload) => {
    const skillKey = payload.skillKey.trim();
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
      const endpoint = payload.kind === 'markdown'
        ? '/api/skills/import/markdown'
        : '/api/skills/import/bundle';
      const body = payload.kind === 'markdown'
        ? { content: payload.content }
        : { skillKey, files: payload.files };
      const result = await hostApiFetch<SkillsMutationResponse>(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
      });
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

  uninstallSkill: async (skillKey: string, slug?: string) => {
    set((state) => {
      const nextMutating = incrementMutatingSkill(state.mutatingBySkillId, skillKey);
      return {
        installing: { ...state.installing, [skillKey]: true },
        mutatingBySkillId: nextMutating,
        mutating: true,
      };
    });
    try {
      const result = await hostApiFetch<SkillsUninstallResponse>('/api/skills/uninstall', {
        method: 'POST',
        body: JSON.stringify({ skillKey, ...(slug ? { slug } : {}) }),
      });
      if (result.outcome !== 'removed') {
        throw new Error('Uninstall failed');
      }
      set((state) => ({
        skills: state.skills.filter((skill) =>
          skill.id !== skillKey && (!slug || skill.slug !== slug)
        ),
      }));
      void get().fetchSkills({ force: true, silent: true, fresh: true });
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

  enableSkill: async (skillId) => {
    const { updateSkill } = get();
    set((state) => {
      const nextMutating = incrementMutatingSkill(state.mutatingBySkillId, skillId);
      return {
        mutatingBySkillId: nextMutating,
        mutating: true,
      };
    });

    try {
      const result = await hostApiFetch<SkillsMutationResponse>('/api/skills/config', {
        method: 'POST',
        body: JSON.stringify({ skillKey: skillId, enabled: true }),
      });
      if (result.outcome !== 'accepted') {
        throw new Error('Failed to enable skill');
      }
      const currentSkill = get().skills.find((skill) => skill.id === skillId);
      if (currentSkill) {
        updateSkill(skillId, {
          enabled: true,
          ...(currentSkill.unavailableReason === 'disabled' ? { unavailableReason: null } : {}),
        });
      } else {
        await get().fetchSkills({ force: true, silent: true, fresh: true });
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
      const result = await hostApiFetch<SkillsMutationResponse>('/api/skills/config', {
        method: 'POST',
        body: JSON.stringify({ skillKey: skillId, enabled: false }),
      });
      if (result.outcome !== 'accepted') {
        throw new Error('Failed to disable skill');
      }
      if (skill) {
        updateSkill(skillId, { enabled: false });
      } else {
        await get().fetchSkills({ force: true, silent: true, fresh: true });
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
    const uniqueSkillIds = [...new Set(skillIds.map((skillId) => skillId.trim()).filter(Boolean))];
    if (uniqueSkillIds.length === 0) {
      return;
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
      const result = await skillManagementCapabilityExecute<{ success: boolean; updated?: string[]; error?: string }>(
        'skills.updateBatchState',
        { skillKeys: uniqueSkillIds, enabled },
        { kind: 'skill' },
      );
      if (result.success !== true) {
        throw new Error(result.error || 'Failed to update skills');
      }
      const updatedSkillIds = Array.isArray(result.updated) && result.updated.length > 0
        ? result.updated
        : uniqueSkillIds;
      const updatedSkillIdSet = new Set(updatedSkillIds);
      set((state) => ({
        skills: state.skills.map((skill) =>
          updatedSkillIdSet.has(skill.id)
            ? { ...skill, enabled }
            : skill
        ),
      }));
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
