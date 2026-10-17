import { create } from 'zustand';
import { useAccountStore } from '@/stores/account';
import { hostApiFetch } from '@/lib/host-api';
import { waitForSkillsMutation, requireSkillsScope, selectedSkillsScope } from '@/lib/skills';
import { buildCapabilityScopeKey, runtimeScopeQuery, type RuntimeScope } from '@/types/desktop/runtime-address';
import { AppError, normalizeAppError } from '@/lib/error-model';
import { sealedSkillMutationError } from '@/lib/sealed-skills-error';
import { runCloudPackageOperation } from '@/lib/cloud-package-call';
import type { CloudPackageDownloadInput } from '@/types/cloud-package-operation';
import type { CallReceipt } from '@/types/call-log';
import type { SealedSkillCatalogIssue, SealedSkillCloudPackage, SealedSkillMetadata } from '@/types/skill';
import type { CloudPackageListPage, CloudPackageVersion, InstalledCloudPackage, InstalledCloudPackageList } from '@/types/cloud-package';

export const SEALED_SKILL_CLOUD_ENDPOINTS = {
  list: '/api/packages/market?packageType=skill',
  mine: '/api/packages/mine?packageType=skill',
  uploadInstalledPackage: '/api/packages/upload/sealed-skill',
  installFromCloud: '/api/packages/install',
} as const;

export const SEALED_SKILL_LOCAL_ENDPOINTS = {
  install: '/api/sealed-skills/install-local',
} as const;

export const SEALED_SKILL_CLOUD_UNAVAILABLE_ERROR = 'cloudUnavailable';

type SealedSkillStatusEntry = SealedSkillMetadata;

type SealedSkillsStatusResult = {
  skills?: SealedSkillStatusEntry[];
  issues?: SealedSkillCatalogIssue[];
  error?: string | null;
};

type SealedSkillCloudPackagesResult = {
  items?: CloudPackageVersion[];
  packages?: SealedSkillCloudPackage[];
  error?: string | null;
};

type SealedSkillCloudMutationResult = {
  success?: boolean;
  outcome?: 'accepted' | 'rejected' | 'unknown' | 'notFound' | 'canceled';
  package?: SealedSkillCloudPackage;
  reason?: string;
  install?: { outcome?: 'accepted' | 'rejected' | 'unknown' | 'notFound'; skillKey?: string; reason?: string };
  error?: string | null;
};

interface SealedSkillsState {
  scopeKey: string | null;
  scopeGeneration: number;
  setScope: (scope: RuntimeScope | null) => void;
  skills: SealedSkillMetadata[];
  snapshotReady: boolean;
  issues: SealedSkillCatalogIssue[];
  cloudPackages: SealedSkillCloudPackage[];
  installedCloudPackages: InstalledCloudPackage[];
  myCloudPackages: CloudPackageVersion[];
  myCloudLoading: boolean;
  myCloudLoaded: boolean;
  myCloudError: AppError | string | null;
  cloudPublishingByVersionId: Record<string, boolean>;
  loading: boolean;
  cloudLoading: boolean;
  cloudLoaded: boolean;
  localPackageInstalling: boolean;
  exportingBySkillKey: Record<string, boolean>;
  uninstallingBySkillKey: Record<string, boolean>;
  cloudUploadingBySkillKey: Record<string, boolean>;
  cloudInstallingByPackageKey: Record<string, boolean>;
  error: AppError | string | null;
  cloudError: AppError | string | null;
  fetchSealedSkills: () => Promise<void>;
  fetchCloudSkillPackages: () => Promise<void>;
  fetchMyCloudSkillPackages: () => Promise<void>;
  publishCloudSkillPackage: (packageVersionId: string) => Promise<{ refreshed: boolean } | undefined>;
  exportSkillPackage: (skillKey: string) => Promise<{ refreshed: boolean; warning?: 'cleanup-failed' } | undefined>;
  uninstallSealedSkill: (skillKey: string) => Promise<void>;
  uploadInstalledSkillPackageToCloud: (skillKey: string) => Promise<{ refreshed: boolean; warning?: 'cleanup-failed' } | undefined>;
  installLocalSkillPackage: () => Promise<boolean>;
  downloadAndInstallCloudSkillPackage: (packageInfo: SealedSkillCloudPackage) => Promise<void>;
}

export function getSealedSkillCloudPackageKey(packageInfo: SealedSkillCloudPackage): string {
  return packageInfo.packageVersionId?.trim()
    || packageInfo.packageId?.trim()
    || packageInfo.skillKey?.trim()
    || packageInfo.fileName?.trim()
    || 'cloud-package';
}

function toSealedSkillMetadata(value: SealedSkillStatusEntry): SealedSkillMetadata {
  return {
    skillKey: value.skillKey,
    name: value.name,
    description: value.description,
    installed: value.installed,
    version: value.version,
    source: value.source,
    runtimes: value.runtimes,
  };
}

function toSealedSkillCloudPackage(value: CloudPackageVersion): SealedSkillCloudPackage {
  return {
    packageId: value.packageId,
    packageVersionId: value.packageVersionId,
    packageType: value.packageType,
    skillKey: value.name,
    name: value.displayName || value.name,
    description: value.description,
    version: value.version,
    status: value.status,
    entitlementStatus: value.entitlementStatus,
    downloadable: value.downloadable,
  };
}

function buildCloudPackageRequest(packageInfo: SealedSkillCloudPackage): CloudPackageDownloadInput {
  const packageVersionId = packageInfo.packageVersionId?.trim();
  if (!packageVersionId) {
    throw new Error('Cloud skill package version is required');
  }
  return {
    packageVersionId,
    packageType: 'skill',
    source: 'skills',
  };
}

function assertCloudMutationAccepted(result: SealedSkillCloudMutationResult): void {
  const outcome = result.install?.outcome ?? result.outcome;
  if (result.success === false || result.error || (outcome && outcome !== 'accepted')) {
    throw sealedSkillMutationError({ outcome: outcome ?? 'rejected', reason: result.install?.reason ?? result.reason });
  }
}

async function hostListCloudSkillPackages(): Promise<SealedSkillCloudPackagesResult> {
  return hostApiFetch<SealedSkillCloudPackagesResult>(SEALED_SKILL_CLOUD_ENDPOINTS.list);
}

async function hostUploadInstalledSkillPackageToCloud(skillKey: string, scope: ReturnType<typeof requireSkillsScope>): Promise<{ package: CloudPackageVersion; warning?: 'cleanup-failed' }> {
  const receipt = await hostApiFetch<CallReceipt>(SEALED_SKILL_CLOUD_ENDPOINTS.uploadInstalledPackage, {
    method: 'POST',
    body: JSON.stringify({ skillKey, scope }),
  });
  const exported = await waitForSkillsMutation(receipt, 'sealedSkills.exportCloud', { skillKey, scope });
  const warning: 'cleanup-failed' | undefined = exported.outcome === 'partial' && exported.reason === 'cleanup-failed' ? 'cleanup-failed' : undefined;
  if (exported.outcome !== 'accepted' && !warning) throw sealedSkillMutationError(exported);
  try {
    const uploaded = await runCloudPackageOperation('confirmSealedSkillUpload', { callId: receipt.callId, scope });
    return { package: uploaded, ...(warning ? { warning } : {}) };
  } catch (error) {
    if (!warning) throw error;
    throw normalizeAppError(error, {
      ...(error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? { status: error.status } : {}),
      exportWarning: warning,
    });
  }
}

async function hostInstallLocalSkillPackage(scope: ReturnType<typeof requireSkillsScope>): Promise<SealedSkillCloudMutationResult> {
  const receipt = await hostApiFetch<CallReceipt | { outcome: 'canceled' }>(SEALED_SKILL_LOCAL_ENDPOINTS.install, {
    method: 'POST',
    body: JSON.stringify({ scope }),
    timeoutMs: 120000,
  });
  if ('outcome' in receipt && receipt.outcome === 'canceled') return receipt;
  const result = await waitForSkillsMutation(receipt, 'sealedSkills.install', { scope });
  if (result.outcome === 'removed' || result.outcome === 'partial') throw new Error('Invalid Skills install result');
  return { ...result, outcome: result.outcome };
}

async function hostInstallCloudSkillPackage(packageInfo: SealedSkillCloudPackage, scope: ReturnType<typeof requireSkillsScope>): Promise<SealedSkillCloudMutationResult> {
  const request = buildCloudPackageRequest(packageInfo);
  const response = await runCloudPackageOperation('install', { ...request, scope });
  if (response.packageVersionId !== request.packageVersionId) throw new Error('Invalid cloud package installation identity');
  const installed = await waitForSkillsMutation(response.install, 'sealedSkills.install', { scope });
  const confirmed = await hostApiFetch<Pick<SealedSkillCloudMutationResult, 'install'>>('/api/packages/install/confirm', {
    method: 'POST',
    body: JSON.stringify({ callId: response.install.callId }),
  });
  if (!confirmed.install?.outcome || confirmed.install.outcome !== installed.outcome
    || (installed.outcome === 'accepted' && confirmed.install.skillKey !== installed.skillKey)) {
    throw new Error('Invalid cloud skill install confirmation');
  }
  return { ...response, install: { ...confirmed.install, reason: installed.reason } };
}

async function hostUninstallSealedSkill(skillKey: string, scope: ReturnType<typeof requireSkillsScope>) {
  const receipt = await hostApiFetch<CallReceipt>('/api/sealed-skills/uninstall', {
    method: 'POST',
    body: JSON.stringify({ skillKey, scope }),
  });
  return waitForSkillsMutation(receipt, 'sealedSkills.uninstall', { skillKey, scope });
}

let cloudAccountRevision = 0;
let cloudFetchTask: Promise<void> | null = null;
let myCloudFetchTask: Promise<void> | null = null;

function clearCloudAccountPackages(error: AppError | null = null): void {
  cloudAccountRevision += 1;
  cloudFetchTask = null;
  myCloudFetchTask = null;
  useSealedSkillsStore.setState({
    cloudPackages: [],
    installedCloudPackages: [],
    myCloudPackages: [],
    cloudLoading: false,
    myCloudLoading: false,
    cloudLoaded: error !== null,
    myCloudLoaded: error !== null,
    cloudError: error,
    myCloudError: error,
  });
}

function scopedMutation(): {
  scope: ReturnType<typeof requireSkillsScope>;
  set: (partial: Partial<SealedSkillsState> | ((state: SealedSkillsState) => Partial<SealedSkillsState>)) => void;
  current: () => boolean;
} {
  const scope = requireSkillsScope();
  useSealedSkillsStore.getState().setScope(scope);
  const key = buildCapabilityScopeKey(scope);
  const generation = useSealedSkillsStore.getState().scopeGeneration;
  const current = (): boolean => {
    const selected = selectedSkillsScope();
    return Boolean(selected && buildCapabilityScopeKey(selected) === key
      && useSealedSkillsStore.getState().scopeGeneration === generation);
  };
  const set = (partial: Partial<SealedSkillsState> | ((state: SealedSkillsState) => Partial<SealedSkillsState>)) => {
    if (current()) useSealedSkillsStore.setState(partial);
  };
  return { scope, set, current };
}

export const useSealedSkillsStore = create<SealedSkillsState>((set, get) => ({
  scopeKey: null,
  scopeGeneration: 0,
  setScope: (scope) => {
    const scopeKey = scope ? buildCapabilityScopeKey(scope) : null;
    if (scopeKey === get().scopeKey) return;
    set((state) => ({
      scopeKey, scopeGeneration: state.scopeGeneration + 1,
      skills: [], snapshotReady: false, issues: [], loading: false, error: null, localPackageInstalling: false,
      exportingBySkillKey: {}, uninstallingBySkillKey: {}, cloudUploadingBySkillKey: {}, cloudInstallingByPackageKey: {},
    }));
  },
  skills: [],
  snapshotReady: false,
  issues: [],
  cloudPackages: [],
  installedCloudPackages: [],
  myCloudPackages: [],
  myCloudLoading: false,
  myCloudLoaded: false,
  myCloudError: null,
  cloudPublishingByVersionId: {},
  loading: false,
  cloudLoading: false,
  cloudLoaded: false,
  localPackageInstalling: false,
  exportingBySkillKey: {},
  uninstallingBySkillKey: {},
  cloudUploadingBySkillKey: {},
  cloudInstallingByPackageKey: {},
  error: null,
  cloudError: null,

  fetchSealedSkills: async () => {
    if (!selectedSkillsScope()) { get().setScope(null); return; }
    const { scope, set } = scopedMutation();
    set({ loading: true, error: null });
    try {
      const result = await hostApiFetch<SealedSkillsStatusResult>(`/api/sealed-skills/status?${runtimeScopeQuery(scope)}`);
      set({
        skills: Array.isArray(result.skills) ? result.skills.map(toSealedSkillMetadata) : [],
        snapshotReady: get().snapshotReady || !result.error,
        issues: result.issues ?? [],
        error: result.error ?? null,
      });
    } catch (error) {
      set({ error: normalizeAppError(error) });
    } finally {
      set({ loading: false });
    }
  },

  fetchCloudSkillPackages: () => {
    if (cloudFetchTask) return cloudFetchTask;
    const revision = cloudAccountRevision;
    set({ cloudLoading: true });
    cloudFetchTask = Promise.resolve().then(async () => {
      try {
        const [result, installed] = await Promise.all([
          hostListCloudSkillPackages(),
          hostApiFetch<InstalledCloudPackageList>('/api/packages/installed'),
        ]);
        if (revision !== cloudAccountRevision) return;
        if (result.error) {
          set({ cloudError: result.error });
          return;
        }
        set({
          installedCloudPackages: installed.packages,
          cloudPackages: Array.isArray(result.items)
            ? result.items.map(toSealedSkillCloudPackage)
            : Array.isArray(result.packages) ? result.packages : [],
          cloudError: null,
        });
      } catch (error) {
        if (revision !== cloudAccountRevision) return;
        const failure = normalizeAppError(error);
        if (failure.details?.status === 401) clearCloudAccountPackages(failure);
        else set({ cloudError: failure });
      } finally {
        if (revision === cloudAccountRevision) {
          cloudFetchTask = null;
          set({ cloudLoading: false, cloudLoaded: true });
        }
      }
    });
    return cloudFetchTask;
  },

  fetchMyCloudSkillPackages: () => {
    if (myCloudFetchTask) return myCloudFetchTask;
    const revision = cloudAccountRevision;
    set({ myCloudLoading: true });
    myCloudFetchTask = Promise.resolve().then(async () => {
      try {
        const result = await hostApiFetch<CloudPackageListPage>(SEALED_SKILL_CLOUD_ENDPOINTS.mine);
        if (revision !== cloudAccountRevision) return;
        set((state) => ({
          myCloudPackages: result.items.map((item) => {
            const published = state.cloudPublishingByVersionId[item.packageVersionId]
              && state.myCloudPackages.find((current) => current.packageVersionId === item.packageVersionId && current.status === 'published');
            return item.status === 'draft' && published ? published : item;
          }),
          myCloudError: null,
        }));
      } catch (error) {
        if (revision !== cloudAccountRevision) return;
        const failure = normalizeAppError(error);
        if (failure.details?.status === 401) clearCloudAccountPackages(failure);
        else set({ myCloudError: failure });
      } finally {
        if (revision === cloudAccountRevision) {
          myCloudFetchTask = null;
          set({ myCloudLoading: false, myCloudLoaded: true });
        }
      }
    });
    return myCloudFetchTask;
  },

  publishCloudSkillPackage: async (packageVersionId) => {
    if (get().cloudPublishingByVersionId[packageVersionId]) return;
    set((state) => ({ cloudPublishingByVersionId: { ...state.cloudPublishingByVersionId, [packageVersionId]: true } }));
    const revision = cloudAccountRevision;
    try {
      const published = await hostApiFetch<CloudPackageVersion>(`/api/packages/${encodeURIComponent(packageVersionId)}/publish`, { method: 'POST' });
      if (revision !== cloudAccountRevision) return;
      set((state) => ({ myCloudPackages: state.myCloudPackages.map((item) => item.packageVersionId === packageVersionId ? published : item) }));
      await Promise.all([myCloudFetchTask, cloudFetchTask]);
      if (revision !== cloudAccountRevision) return;
      await Promise.all([get().fetchMyCloudSkillPackages(), get().fetchCloudSkillPackages()]);
      if (revision !== cloudAccountRevision) return;
      return { refreshed: get().myCloudError === null && get().cloudError === null };
    } finally {
      set((state) => {
        const next = { ...state.cloudPublishingByVersionId };
        delete next[packageVersionId];
        return { cloudPublishingByVersionId: next };
      });
    }
  },

  exportSkillPackage: async (skillKey) => {
    const { scope, set, current } = scopedMutation();
    const normalizedSkillKey = skillKey.trim();
    if (!normalizedSkillKey || get().exportingBySkillKey[normalizedSkillKey]) {
      return;
    }

    set((state) => ({
      exportingBySkillKey: { ...state.exportingBySkillKey, [normalizedSkillKey]: true },
    }));

    try {
      const receipt = await hostApiFetch<CallReceipt>('/api/sealed-skills/export', {
        method: 'POST',
        body: JSON.stringify({ skillKey: normalizedSkillKey, scope }),
      });
      const result = await waitForSkillsMutation(receipt, 'sealedSkills.export', { skillKey: normalizedSkillKey, scope });
      const warning: 'cleanup-failed' | undefined = result.outcome === 'partial' && result.reason === 'cleanup-failed' ? 'cleanup-failed' : undefined;
      if (result.outcome !== 'accepted' && !warning) {
        throw sealedSkillMutationError(result);
      }
      if (!current()) return;
      await get().fetchSealedSkills();
      if (!current()) return;
      return { refreshed: get().error === null, ...(warning ? { warning } : {}) };
    } finally {
      set((state) => {
        const nextExporting = { ...state.exportingBySkillKey };
        delete nextExporting[normalizedSkillKey];
        return { exportingBySkillKey: nextExporting };
      });
    }
  },

  uninstallSealedSkill: async (skillKey) => {
    const { scope, set, current } = scopedMutation();
    const normalizedSkillKey = skillKey.trim();
    if (!normalizedSkillKey || get().uninstallingBySkillKey[normalizedSkillKey]) {
      return;
    }

    set((state) => ({
      uninstallingBySkillKey: { ...state.uninstallingBySkillKey, [normalizedSkillKey]: true },
    }));

    try {
      const result = await hostUninstallSealedSkill(normalizedSkillKey, scope);
      if (result.outcome !== 'removed') {
        throw sealedSkillMutationError(result);
      }
      if (!current()) return;
      await get().fetchSealedSkills();
      await cloudFetchTask;
      if (!current()) return;
      await get().fetchCloudSkillPackages();
    } finally {
      set((state) => {
        const nextUninstalling = { ...state.uninstallingBySkillKey };
        delete nextUninstalling[normalizedSkillKey];
        return { uninstallingBySkillKey: nextUninstalling };
      });
    }
  },

  uploadInstalledSkillPackageToCloud: async (skillKey) => {
    const { scope, set, current } = scopedMutation();
    const normalizedSkillKey = skillKey.trim();
    if (!normalizedSkillKey || get().cloudUploadingBySkillKey[normalizedSkillKey]) {
      return;
    }

    set((state) => ({
      cloudUploadingBySkillKey: { ...state.cloudUploadingBySkillKey, [normalizedSkillKey]: true },
    }));
    try {
      const result = await hostUploadInstalledSkillPackageToCloud(normalizedSkillKey, scope);
      await myCloudFetchTask;
      if (!current()) return;
      await get().fetchMyCloudSkillPackages();
      if (!current()) return;
      return { refreshed: get().myCloudError === null, ...(result.warning ? { warning: result.warning } : {}) };
    } finally {
      set((state) => {
        const nextUploading = { ...state.cloudUploadingBySkillKey };
        delete nextUploading[normalizedSkillKey];
        return { cloudUploadingBySkillKey: nextUploading };
      });
    }
  },

  installLocalSkillPackage: async (): Promise<boolean> => {
    const { scope, set, current } = scopedMutation();
    if (get().localPackageInstalling) {
      return false;
    }

    set({ localPackageInstalling: true });
    try {
      const result = await hostInstallLocalSkillPackage(scope);
      if (result.outcome === 'canceled') {
        return false;
      }
      assertCloudMutationAccepted(result);
      if (!current()) return false;
      await get().fetchSealedSkills();
      return current();
    } finally {
      set({ localPackageInstalling: false });
    }
  },

  downloadAndInstallCloudSkillPackage: async (packageInfo) => {
    const { scope, set, current } = scopedMutation();
    const packageKey = getSealedSkillCloudPackageKey(packageInfo);
    if (get().cloudInstallingByPackageKey[packageKey]) {
      return;
    }

    set((state) => ({
      cloudInstallingByPackageKey: { ...state.cloudInstallingByPackageKey, [packageKey]: true },
    }));

    try {
      const result = await hostInstallCloudSkillPackage(packageInfo, scope);
      assertCloudMutationAccepted(result);
      if (!current()) return;
      await get().fetchSealedSkills();
      await cloudFetchTask;
      if (!current()) return;
      await get().fetchCloudSkillPackages();
    } finally {
      set((state) => {
        const nextInstalling = { ...state.cloudInstallingByPackageKey };
        delete nextInstalling[packageKey];
        return { cloudInstallingByPackageKey: nextInstalling };
      });
    }
  },
}));

useAccountStore.subscribe((account, previous) => {
  const sessionInvalidated = (account.status === 'signedOut' || account.status === 'requires2fa')
    && account.status !== previous.status;
  if (account.user?.id !== previous.user?.id || sessionInvalidated) clearCloudAccountPackages();
});
