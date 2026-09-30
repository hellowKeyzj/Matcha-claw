import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { waitForSkillsMutation } from '@/lib/skills';
import { runCloudPackageOperation } from '@/lib/cloud-package-call';
import type { CloudPackageDownloadInput } from '@/types/cloud-package-operation';
import type { CallReceipt } from '@/types/call-log';
import type { SealedSkillCloudPackage, SealedSkillMetadata } from '@/types/skill';
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
  install?: { outcome?: 'accepted' | 'rejected' | 'unknown' | 'notFound'; skillKey?: string };
  error?: string | null;
};

interface SealedSkillsState {
  skills: SealedSkillMetadata[];
  cloudPackages: SealedSkillCloudPackage[];
  installedCloudPackages: InstalledCloudPackage[];
  myCloudPackages: CloudPackageVersion[];
  myCloudLoading: boolean;
  myCloudError: string | null;
  cloudPublishingByVersionId: Record<string, boolean>;
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
  fetchMyCloudSkillPackages: () => Promise<void>;
  publishCloudSkillPackage: (packageVersionId: string) => Promise<void>;
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

async function hostUploadInstalledSkillPackageToCloud(skillKey: string): Promise<CloudPackageVersion> {
  const receipt = await hostApiFetch<CallReceipt>(SEALED_SKILL_CLOUD_ENDPOINTS.uploadInstalledPackage, {
    method: 'POST',
    body: JSON.stringify({ skillKey }),
  });
  const exported = await waitForSkillsMutation(receipt, 'sealedSkills.exportCloud', { skillKey });
  if (exported.outcome !== 'accepted') throw new Error('Failed to export cloud skill package');
  return runCloudPackageOperation('confirmSealedSkillUpload', { callId: receipt.callId });
}

async function hostInstallLocalSkillPackage(): Promise<SealedSkillCloudMutationResult> {
  const receipt = await hostApiFetch<CallReceipt | { outcome: 'canceled' }>(SEALED_SKILL_LOCAL_ENDPOINTS.install, {
    method: 'POST',
    timeoutMs: 120000,
  });
  if ('outcome' in receipt && receipt.outcome === 'canceled') return receipt;
  const result = await waitForSkillsMutation(receipt, 'sealedSkills.install');
  if (result.outcome === 'removed' || result.outcome === 'partial') throw new Error('Invalid Skills install result');
  return { ...result, outcome: result.outcome };
}

async function hostInstallCloudSkillPackage(packageInfo: SealedSkillCloudPackage): Promise<SealedSkillCloudMutationResult> {
  const request = buildCloudPackageRequest(packageInfo);
  const response = await runCloudPackageOperation('install', request);
  if (response.packageVersionId !== request.packageVersionId) throw new Error('Invalid cloud package installation identity');
  const installed = await waitForSkillsMutation(response.install, 'sealedSkills.install');
  const confirmed = await hostApiFetch<Pick<SealedSkillCloudMutationResult, 'install'>>('/api/packages/install/confirm', {
    method: 'POST',
    body: JSON.stringify({ callId: response.install.callId }),
  });
  if (!confirmed.install?.outcome || confirmed.install.outcome !== installed.outcome
    || (installed.outcome === 'accepted' && confirmed.install.skillKey !== installed.skillKey)) {
    throw new Error('Invalid cloud skill install confirmation');
  }
  return { ...response, install: confirmed.install };
}

async function hostUninstallSealedSkill(skillKey: string) {
  const receipt = await hostApiFetch<CallReceipt>('/api/sealed-skills/uninstall', {
    method: 'POST',
    body: JSON.stringify({ skillKey }),
  });
  return waitForSkillsMutation(receipt, 'sealedSkills.uninstall', { skillKey });
}

export const useSealedSkillsStore = create<SealedSkillsState>((set, get) => ({
  skills: [],
  cloudPackages: [],
  installedCloudPackages: [],
  myCloudPackages: [],
  myCloudLoading: false,
  myCloudError: null,
  cloudPublishingByVersionId: {},
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
      const [result, installed] = await Promise.all([
        hostListCloudSkillPackages(),
        hostApiFetch<InstalledCloudPackageList>('/api/packages/installed'),
      ]);
      set({
        installedCloudPackages: installed.packages,
        cloudPackages: Array.isArray(result.items)
          ? result.items.map(toSealedSkillCloudPackage)
          : Array.isArray(result.packages) ? result.packages : [],
        cloudError: result.error ?? null,
      });
    } catch {
      set({ cloudPackages: [], installedCloudPackages: [], cloudError: SEALED_SKILL_CLOUD_UNAVAILABLE_ERROR });
    } finally {
      set({ cloudLoading: false });
    }
  },

  fetchMyCloudSkillPackages: async () => {
    set({ myCloudLoading: true, myCloudError: null });
    try {
      const result = await hostApiFetch<CloudPackageListPage>(SEALED_SKILL_CLOUD_ENDPOINTS.mine);
      set({ myCloudPackages: result.items });
    } catch {
      set({ myCloudError: SEALED_SKILL_CLOUD_UNAVAILABLE_ERROR });
    } finally {
      set({ myCloudLoading: false });
    }
  },

  publishCloudSkillPackage: async (packageVersionId) => {
    if (get().cloudPublishingByVersionId[packageVersionId]) return;
    set((state) => ({ cloudPublishingByVersionId: { ...state.cloudPublishingByVersionId, [packageVersionId]: true } }));
    try {
      const published = await hostApiFetch<CloudPackageVersion>(`/api/packages/${encodeURIComponent(packageVersionId)}/publish`, { method: 'POST' });
      set((state) => ({ myCloudPackages: state.myCloudPackages.map((item) => item.packageVersionId === packageVersionId ? published : item) }));
      await get().fetchCloudSkillPackages();
    } finally {
      set((state) => {
        const next = { ...state.cloudPublishingByVersionId };
        delete next[packageVersionId];
        return { cloudPublishingByVersionId: next };
      });
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
      const receipt = await hostApiFetch<CallReceipt>('/api/sealed-skills/export', {
        method: 'POST',
        body: JSON.stringify({ skillKey: normalizedSkillKey }),
      });
      const result = await waitForSkillsMutation(receipt, 'sealedSkills.export', { skillKey: normalizedSkillKey });
      if (result.outcome !== 'accepted') {
        throw new Error('Failed to export skill package');
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
        throw new Error('Failed to uninstall skill package');
      }
      await get().fetchSealedSkills();
      await get().fetchCloudSkillPackages();
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
    }));
    try {
      await hostUploadInstalledSkillPackageToCloud(normalizedSkillKey);
      await get().fetchMyCloudSkillPackages();
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
    }));

    try {
      const result = await hostInstallCloudSkillPackage(packageInfo);
      assertCloudMutationAccepted(result, 'Failed to install cloud skill package');
      await get().fetchSealedSkills();
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
