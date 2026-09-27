import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import type { SealedSkillCloudPackage, SealedSkillMetadata } from '@/types/skill';

export const SEALED_SKILL_CLOUD_ENDPOINTS = {
  list: '/api/packages/market?packageType=skill',
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
  error?: string | null;
};

type SealedSkillsExportResult = {
  outcome?: 'accepted' | 'rejected' | 'unknown' | 'notFound';
  skill?: SealedSkillMetadata;
  error?: string;
};

type SealedSkillsUninstallResult = {
  outcome: 'removed' | 'notFound' | 'rejected' | 'unknown';
  skillKey?: string;
  error?: string;
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
  install?: { outcome?: 'accepted' | 'rejected' | 'unknown' | 'notFound'; skillKey?: string };
  error?: string | null;
};

type CloudPackageVersion = {
  packageId: string;
  packageVersionId: string;
  name: string;
  displayName?: string;
  packageType: string;
  version: string;
  description?: string;
  status: string;
  entitlementStatus?: string;
  downloadable: boolean;
};

interface SealedSkillsState {
  skills: SealedSkillMetadata[];
  cloudPackages: SealedSkillCloudPackage[];
  loading: boolean;
  cloudLoading: boolean;
  localPackageInstalling: boolean;
  exportingBySkillKey: Record<string, boolean>;
  uninstallingBySkillKey: Record<string, boolean>;
  cloudUploadingBySkillKey: Record<string, boolean>;
  cloudInstallingByPackageKey: Record<string, boolean>;
  error: string | null;
  cloudError: string | null;
  fetchSealedSkills: () => Promise<void>;
  fetchCloudSkillPackages: () => Promise<void>;
  exportSkillPackage: (skillKey: string) => Promise<void>;
  uninstallSealedSkill: (skillKey: string) => Promise<void>;
  uploadInstalledSkillPackageToCloud: (skillKey: string) => Promise<void>;
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
    installed: value.downloadable && value.entitlementStatus === 'active',
    downloadable: value.downloadable,
  };
}

function buildCloudPackageRequest(packageInfo: SealedSkillCloudPackage): Record<string, string> {
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

function assertCloudMutationAccepted(result: SealedSkillCloudMutationResult, fallbackError: string): void {
  if (result.success === false || result.error) {
    throw new Error(result.error || fallbackError);
  }
  const outcome = result.install?.outcome ?? result.outcome;
  if (outcome && outcome !== 'accepted') {
    throw new Error(fallbackError);
  }
}

async function hostListCloudSkillPackages(): Promise<SealedSkillCloudPackagesResult> {
  return hostApiFetch<SealedSkillCloudPackagesResult>(SEALED_SKILL_CLOUD_ENDPOINTS.list);
}

async function hostUploadInstalledSkillPackageToCloud(skillKey: string): Promise<SealedSkillCloudMutationResult> {
  return hostApiFetch<SealedSkillCloudMutationResult>(SEALED_SKILL_CLOUD_ENDPOINTS.uploadInstalledPackage, {
    method: 'POST',
    body: JSON.stringify({ skillKey }),
    timeoutMs: 120000,
  });
}

async function hostInstallLocalSkillPackage(): Promise<SealedSkillCloudMutationResult> {
  return hostApiFetch<SealedSkillCloudMutationResult>(SEALED_SKILL_LOCAL_ENDPOINTS.install, {
    method: 'POST',
    timeoutMs: 120000,
  });
}

async function hostInstallCloudSkillPackage(packageInfo: SealedSkillCloudPackage): Promise<SealedSkillCloudMutationResult> {
  return hostApiFetch<SealedSkillCloudMutationResult>(SEALED_SKILL_CLOUD_ENDPOINTS.installFromCloud, {
    method: 'POST',
    body: JSON.stringify(buildCloudPackageRequest(packageInfo)),
    timeoutMs: 120000,
  });
}

async function hostUninstallSealedSkill(skillKey: string): Promise<SealedSkillsUninstallResult> {
  return hostApiFetch<SealedSkillsUninstallResult>('/api/sealed-skills/uninstall', {
    method: 'POST',
    body: JSON.stringify({ skillKey }),
  });
}

export const useSealedSkillsStore = create<SealedSkillsState>((set, get) => ({
  skills: [],
  cloudPackages: [],
  loading: false,
  cloudLoading: false,
  localPackageInstalling: false,
  exportingBySkillKey: {},
  uninstallingBySkillKey: {},
  cloudUploadingBySkillKey: {},
  cloudInstallingByPackageKey: {},
  error: null,
  cloudError: null,

  fetchSealedSkills: async () => {
    set({ loading: true, error: null });
    try {
      const result = await hostApiFetch<SealedSkillsStatusResult>('/api/sealed-skills/status');
      set({
        skills: Array.isArray(result.skills) ? result.skills.map(toSealedSkillMetadata) : [],
        error: result.error ?? null,
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },

  fetchCloudSkillPackages: async () => {
    set({ cloudLoading: true, cloudError: null });
    try {
      const result = await hostListCloudSkillPackages();
      set({
        cloudPackages: Array.isArray(result.items)
          ? result.items.map(toSealedSkillCloudPackage)
          : Array.isArray(result.packages) ? result.packages : [],
        cloudError: result.error ?? null,
      });
    } catch {
      set({ cloudPackages: [], cloudError: SEALED_SKILL_CLOUD_UNAVAILABLE_ERROR });
    } finally {
      set({ cloudLoading: false });
    }
  },

  exportSkillPackage: async (skillKey) => {
    const normalizedSkillKey = skillKey.trim();
    if (!normalizedSkillKey || get().exportingBySkillKey[normalizedSkillKey]) {
      return;
    }

    set((state) => ({
      exportingBySkillKey: { ...state.exportingBySkillKey, [normalizedSkillKey]: true },
      error: null,
    }));

    try {
      const result = await hostApiFetch<SealedSkillsExportResult>('/api/sealed-skills/export', {
        method: 'POST',
        body: JSON.stringify({ skillKey: normalizedSkillKey }),
      });
      if (result.outcome && result.outcome !== 'accepted') {
        throw new Error(result.error || 'Failed to export skill package');
      }
      await get().fetchSealedSkills();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      set((state) => {
        const nextExporting = { ...state.exportingBySkillKey };
        delete nextExporting[normalizedSkillKey];
        return { exportingBySkillKey: nextExporting };
      });
    }
  },

  uninstallSealedSkill: async (skillKey) => {
    const normalizedSkillKey = skillKey.trim();
    if (!normalizedSkillKey || get().uninstallingBySkillKey[normalizedSkillKey]) {
      return;
    }

    set((state) => ({
      uninstallingBySkillKey: { ...state.uninstallingBySkillKey, [normalizedSkillKey]: true },
      error: null,
    }));

    try {
      const result = await hostUninstallSealedSkill(normalizedSkillKey);
      if (result.outcome !== 'removed') {
        throw new Error(result.error || 'Failed to uninstall skill package');
      }
      await get().fetchSealedSkills();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      set((state) => {
        const nextUninstalling = { ...state.uninstallingBySkillKey };
        delete nextUninstalling[normalizedSkillKey];
        return { uninstallingBySkillKey: nextUninstalling };
      });
    }
  },

  uploadInstalledSkillPackageToCloud: async (skillKey) => {
    const normalizedSkillKey = skillKey.trim();
    if (!normalizedSkillKey || get().cloudUploadingBySkillKey[normalizedSkillKey]) {
      return;
    }

    set((state) => ({
      cloudUploadingBySkillKey: { ...state.cloudUploadingBySkillKey, [normalizedSkillKey]: true },
      cloudError: null,
    }));
    try {
      const result = await hostUploadInstalledSkillPackageToCloud(normalizedSkillKey);
      assertCloudMutationAccepted(result, 'Failed to upload skill package');
      await get().fetchCloudSkillPackages();
    } catch (error) {
      set({ cloudError: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      set((state) => {
        const nextUploading = { ...state.cloudUploadingBySkillKey };
        delete nextUploading[normalizedSkillKey];
        return { cloudUploadingBySkillKey: nextUploading };
      });
    }
  },

  installLocalSkillPackage: async () => {
    if (get().localPackageInstalling) {
      return false;
    }

    set({ localPackageInstalling: true, error: null });
    try {
      const result = await hostInstallLocalSkillPackage();
      if (result.outcome === 'canceled') {
        return false;
      }
      assertCloudMutationAccepted(result, 'Failed to install skill package');
      await get().fetchSealedSkills();
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      set({ localPackageInstalling: false });
    }
  },

  downloadAndInstallCloudSkillPackage: async (packageInfo) => {
    const packageKey = getSealedSkillCloudPackageKey(packageInfo);
    if (get().cloudInstallingByPackageKey[packageKey]) {
      return;
    }

    set((state) => ({
      cloudInstallingByPackageKey: { ...state.cloudInstallingByPackageKey, [packageKey]: true },
      cloudError: null,
    }));

    try {
      const result = await hostInstallCloudSkillPackage(packageInfo);
      assertCloudMutationAccepted(result, 'Failed to install cloud skill package');
      await get().fetchSealedSkills();
      await get().fetchCloudSkillPackages();
    } catch (error) {
      set({ cloudError: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      set((state) => {
        const nextInstalling = { ...state.cloudInstallingByPackageKey };
        delete nextInstalling[packageKey];
        return { cloudInstallingByPackageKey: nextInstalling };
      });
    }
  },
}));
