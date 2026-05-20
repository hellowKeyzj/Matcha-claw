/**
 * Skills State Store
 * Manages skill/plugin state
 */
import { create } from 'zustand';
import { hostApiFetch, waitForRuntimeJobResult, type RuntimeJobSubmission } from '@/lib/host-api';
import { AppError, normalizeAppError } from '@/lib/error-model';
import type { Skill, MarketplaceSkill, SkillMissingRequirements } from '../types/skill';

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
  emoji?: string;
  version?: string;
  author?: string;
  config?: Record<string, unknown>;
  bundled?: boolean;
  always?: boolean;
  eligible?: boolean;
  blockedByAllowlist?: boolean;
  missing?: GatewaySkillMissing;
  installed?: boolean;
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
  uninstallSkill: (slug: string) => Promise<void>;
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
          ? hostApiFetch<GatewaySkillsStatusResult>('/api/skills/status/refresh', { method: 'POST' })
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
              slug: s.slug || s.skillKey,
              name: s.name || s.skillKey,
              description: s.description || '',
              enabled: !s.disabled,
              icon: s.emoji || '📦',
              version: s.version || '1.0.0',
              author: s.author,
              installed: s.installed !== false,
              eligible: typeof s.eligible === 'boolean' ? s.eligible : undefined,
              blockedByAllowlist: s.blockedByAllowlist === true,
              missing: normalizeMissingRequirements(s.missing),
              config: s.config || {},
              isCore: s.bundled && s.always,
              isBundled: s.bundled,
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
      const result = await hostApiFetch<RuntimeJobSubmission<{ success: boolean }> | { success: false; error?: string }>('/api/clawhub/install', {
        method: 'POST',
        body: JSON.stringify({ slug, version }),
      });
      if (!result.success) {
        const appError = normalizeAppError(new Error(result.error || 'Install failed'), {
          module: 'skills',
          operation: 'install',
        });
        const errorKey = mapErrorCodeToSkillErrorKey(appError.code, 'install');
        throw new Error(errorKey ?? appError.message);
      }
      await waitForRuntimeJobResult<{ success: boolean }>(result.job.id);
      // Refresh skills after install
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

  uninstallSkill: async (slug: string) => {
    set((state) => {
      const nextMutating = incrementMutatingSkill(state.mutatingBySkillId, slug);
      return {
        installing: { ...state.installing, [slug]: true },
        mutatingBySkillId: nextMutating,
        mutating: true,
      };
    });
    try {
      const result = await hostApiFetch<RuntimeJobSubmission<{ success: boolean }>>('/api/clawhub/uninstall', {
        method: 'POST',
        body: JSON.stringify({ slug }),
      });
      if (!result.success) {
        throw new Error('Uninstall failed');
      }
      await waitForRuntimeJobResult<{ success: boolean }>(result.job.id);
      // Refresh skills after uninstall
      await get().fetchSkills({ force: true, fresh: true });
    } catch (error) {
      console.error('Uninstall error:', error);
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
      const result = await hostApiFetch<RuntimeJobSubmission<{ success: boolean; error?: string }>>('/api/skills/state', {
        method: 'PUT',
        body: JSON.stringify({ skillKey: skillId, enabled: true }),
      });
      await waitForRuntimeJobResult<{ success: boolean; error?: string }>(result.job.id);
      updateSkill(skillId, { enabled: true });
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
      const result = await hostApiFetch<RuntimeJobSubmission<{ success: boolean; error?: string }>>('/api/skills/state', {
        method: 'PUT',
        body: JSON.stringify({ skillKey: skillId, enabled: false }),
      });
      await waitForRuntimeJobResult<{ success: boolean; error?: string }>(result.job.id);
      updateSkill(skillId, { enabled: false });
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
      const result = await hostApiFetch<{ success: boolean; updated?: string[]; error?: string }>('/api/skills/state/batch', {
        method: 'PUT',
        body: JSON.stringify({ skillKeys: uniqueSkillIds, enabled }),
      });
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
