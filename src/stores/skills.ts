/**
 * Skills State Store
 * Manages skill/plugin state
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { AppError, normalizeAppError } from '@/lib/error-model';
import { useGatewayStore } from './gateway';
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
  source?: string;
  baseDir?: string;
  filePath?: string;
};

type GatewaySkillsStatusResult = {
  skills?: GatewaySkillStatus[];
};

type MarketplaceSearchResult = {
  success: boolean;
  results?: MarketplaceSkill[];
  error?: string;
};

type ClawHubListResult = {
  slug: string;
  version?: string;
  source?: string;
  baseDir?: string;
};

const MARKETPLACE_SEARCH_CACHE_TTL_MS = 2500;
const SKILLS_FETCH_MIN_INTERVAL_MS = 30000;
const marketplaceSearchCache = new Map<string, {
  timestamp: number;
  results: MarketplaceSkill[];
}>();
const inflightMarketplaceSearch = new Map<string, Promise<MarketplaceSearchResult>>();
let inflightSkillsFetch: Promise<void> | null = null;
let lastSkillsFetchAt = 0;

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
): string {
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
  return 'rateLimitError';
}

interface SkillsState {
  skills: Skill[];
  searchResults: MarketplaceSkill[];
  loading: boolean;
  searching: boolean;
  searchError: string | null;
  installing: Record<string, boolean>; // slug -> boolean
  error: string | null;

  // Actions
  fetchSkills: (options?: { force?: boolean }) => Promise<void>;
  searchSkills: (query: string) => Promise<void>;
  installSkill: (slug: string, version?: string) => Promise<void>;
  uninstallSkill: (slug: string) => Promise<void>;
  enableSkill: (skillId: string) => Promise<void>;
  disableSkill: (skillId: string) => Promise<void>;
  setSkills: (skills: Skill[]) => void;
  updateSkill: (skillId: string, updates: Partial<Skill>) => void;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  searchResults: [],
  loading: false,
  searching: false,
  searchError: null,
  installing: {},
  error: null,

  fetchSkills: async (options) => {
    const force = options?.force === true;
    const now = Date.now();

    if (inflightSkillsFetch) {
      await inflightSkillsFetch;
      return;
    }
    if (!force && get().skills.length > 0 && now - lastSkillsFetchAt < SKILLS_FETCH_MIN_INTERVAL_MS) {
      return;
    }

    // Only show loading state if we have no skills yet (initial load)
    if (get().skills.length === 0) {
      set({ loading: true, error: null });
    }
    inflightSkillsFetch = (async () => {
      try {
        const gatewayPromise = useGatewayStore.getState().rpc<GatewaySkillsStatusResult>('skills.status');
        const configPromise = hostApiFetch<Record<string, { apiKey?: string; env?: Record<string, string> }>>('/api/skills/configs');
        const clawhubListPromise = hostApiFetch<{ success: boolean; results?: ClawHubListResult[] }>('/api/clawhub/list')
          .catch(() => ({ success: false, results: [] }));

        const [gatewayData, configResult, clawhubResult] = await Promise.all([
          gatewayPromise,
          configPromise,
          clawhubListPromise,
        ]);

        let combinedSkills: Skill[] = [];
        const currentSkills = get().skills;

        // Map gateway skills info
        if (gatewayData.skills) {
          combinedSkills = gatewayData.skills.map((s: GatewaySkillStatus) => {
            // Merge with direct config if available
            const directConfig = configResult[s.skillKey] || {};

            return {
              id: s.skillKey,
              slug: s.slug || s.skillKey,
              name: s.name || s.skillKey,
              description: s.description || '',
              enabled: !s.disabled,
              icon: s.emoji || '📦',
              version: s.version || '1.0.0',
              author: s.author,
              eligible: typeof s.eligible === 'boolean' ? s.eligible : undefined,
              blockedByAllowlist: s.blockedByAllowlist === true,
              missing: normalizeMissingRequirements(s.missing),
              config: {
                ...(s.config || {}),
                ...directConfig,
              },
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

        if (clawhubResult.success && Array.isArray(clawhubResult.results)) {
          clawhubResult.results.forEach((installed) => {
            const existing = combinedSkills.find((skill) => skill.id === installed.slug);
            if (existing) {
              if (!existing.baseDir && installed.baseDir) {
                existing.baseDir = installed.baseDir;
              }
              if (!existing.source && installed.source) {
                existing.source = installed.source;
              }
              return;
            }
            const directConfig = configResult[installed.slug] || {};
            combinedSkills.push({
              id: installed.slug,
              slug: installed.slug,
              name: installed.slug,
              description: 'Recently installed, initializing...',
              enabled: false,
              icon: '⌛',
              version: installed.version || 'unknown',
              author: undefined,
              config: directConfig,
              isCore: false,
              isBundled: false,
              source: installed.source || 'openclaw-managed',
              baseDir: installed.baseDir,
            });
          });
        }

        lastSkillsFetchAt = Date.now();
        set({ skills: combinedSkills, loading: false, error: null });
      } catch (error) {
        console.error('Failed to fetch skills:', error);
        const appError = normalizeAppError(error, { module: 'skills', operation: 'fetch' });
        set({ loading: false, error: mapErrorCodeToSkillErrorKey(appError.code, 'fetch') });
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
      set({ searchError: mapErrorCodeToSkillErrorKey(appError.code, 'search') });
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
    set((state) => ({ installing: { ...state.installing, [slug]: true } }));
    try {
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/clawhub/install', {
        method: 'POST',
        body: JSON.stringify({ slug, version }),
      });
      if (!result.success) {
        const appError = normalizeAppError(new Error(result.error || 'Install failed'), {
          module: 'skills',
          operation: 'install',
        });
        throw new Error(mapErrorCodeToSkillErrorKey(appError.code, 'install'));
      }
      // Refresh skills after install
      await get().fetchSkills({ force: true });
    } catch (error) {
      console.error('Install error:', error);
      throw error;
    } finally {
      set((state) => {
        const newInstalling = { ...state.installing };
        delete newInstalling[slug];
        return { installing: newInstalling };
      });
    }
  },

  uninstallSkill: async (slug: string) => {
    set((state) => ({ installing: { ...state.installing, [slug]: true } }));
    try {
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/clawhub/uninstall', {
        method: 'POST',
        body: JSON.stringify({ slug }),
      });
      if (!result.success) {
        throw new Error(result.error || 'Uninstall failed');
      }
      // Refresh skills after uninstall
      await get().fetchSkills({ force: true });
    } catch (error) {
      console.error('Uninstall error:', error);
      throw error;
    } finally {
      set((state) => {
        const newInstalling = { ...state.installing };
        delete newInstalling[slug];
        return { installing: newInstalling };
      });
    }
  },

  enableSkill: async (skillId) => {
    const { updateSkill } = get();

    try {
      await useGatewayStore.getState().rpc('skills.update', { skillKey: skillId, enabled: true });
      updateSkill(skillId, { enabled: true });
    } catch (error) {
      console.error('Failed to enable skill:', error);
      throw error;
    }
  },

  disableSkill: async (skillId) => {
    const { updateSkill, skills } = get();

    const skill = skills.find((s) => s.id === skillId);
    if (skill?.isCore) {
      throw new Error('Cannot disable core skill');
    }

    try {
      await useGatewayStore.getState().rpc('skills.update', { skillKey: skillId, enabled: false });
      updateSkill(skillId, { enabled: false });
    } catch (error) {
      console.error('Failed to disable skill:', error);
      throw error;
    }
  },

  setSkills: (skills) => set({ skills }),

  updateSkill: (skillId, updates) => {
    set((state) => ({
      skills: state.skills.map((skill) =>
        skill.id === skillId ? { ...skill, ...updates } : skill
      ),
    }));
  },
}));
