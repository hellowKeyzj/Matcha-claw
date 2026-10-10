import { create } from 'zustand';
import { fetchLicenseGate, type LicenseGateSnapshot } from '@/lib/license';
import { subscribeHostEvent } from '@/lib/host-events';
import { useAccountStore } from './account';

interface LicenseState {
  snapshot: LicenseGateSnapshot | null;
  error: string | null;
  refresh: () => Promise<void>;
  subscribe: () => () => void;
}

let revision = 0;

export const useLicenseStore = create<LicenseState>((set, get) => ({
  snapshot: null,
  error: null,
  refresh: async () => {
    const requestRevision = ++revision;
    try {
      const snapshot = await fetchLicenseGate();
      if (requestRevision === revision) set({ snapshot, error: null });
    } catch (error) {
      if (requestRevision === revision) {
        set({ snapshot: null, error: error instanceof Error ? error.message : String(error) });
      }
    }
  },
  subscribe: () => {
    const unsubscribe = subscribeHostEvent<LicenseGateSnapshot>('license:gate-changed', (snapshot) => {
      ++revision;
      set({ snapshot, error: null });
    });
    void get().refresh();
    return () => {
      ++revision;
      unsubscribe();
      set({ snapshot: null, error: null });
    };
  },
}));

export function useLocalLicenseLocked(): boolean {
  const accountStatus = useAccountStore((state) => state.status);
  const licenseState = useLicenseStore((state) => state.snapshot?.state);
  return accountStatus !== 'signedIn' && licenseState !== 'granted';
}
