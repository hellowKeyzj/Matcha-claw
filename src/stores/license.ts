import { create } from 'zustand';
import { isTraceEnabled, startupTrace } from '@/lib/trace-logger';
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
    const startedAt = isTraceEnabled() ? performance.now() : 0;
    const requestRevision = ++revision;
    startupTrace('renderer.license', 'refresh.start', () => ({ requestRevision }));
    try {
      const snapshot = await fetchLicenseGate();
      if (requestRevision === revision) {
        set({ snapshot, error: null });
        startupTrace('renderer.license', 'refresh.applied', () => ({
          requestRevision, licenseState: snapshot.state, outcome: 'fulfilled',
        }));
      } else {
        startupTrace('renderer.license', 'refresh.stale', () => ({ requestRevision, outcome: 'fulfilled' }));
      }
    } catch (error) {
      if (requestRevision === revision) {
        set({ snapshot: null, error: error instanceof Error ? error.message : String(error) });
        startupTrace('renderer.license', 'refresh.applied', () => ({ requestRevision, outcome: 'error' }));
      } else {
        startupTrace('renderer.license', 'refresh.stale', () => ({ requestRevision, outcome: 'error' }));
      }
    } finally {
      startupTrace('renderer.license', 'refresh.end', () => ({
        requestRevision, durationMs: Math.round(performance.now() - startedAt),
      }));
    }
  },
  subscribe: () => {
    const startedAt = isTraceEnabled() ? performance.now() : 0;
    startupTrace('renderer.license', 'subscribe.setup');
    const unsubscribe = subscribeHostEvent<LicenseGateSnapshot>('license:gate-changed', (snapshot) => {
      ++revision;
      startupTrace('renderer.license', 'event.received', () => ({ revision, licenseState: snapshot.state }));
      set({ snapshot, error: null });
      startupTrace('renderer.license', 'event.applied', () => ({ revision, licenseState: snapshot.state }));
    });
    startupTrace('renderer.license', 'subscribe.ready');
    void get().refresh();
    return () => {
      startupTrace('renderer.license', 'subscribe.cleanup.start', () => ({
        durationMs: Math.round(performance.now() - startedAt),
      }));
      ++revision;
      unsubscribe();
      set({ snapshot: null, error: null });
      startupTrace('renderer.license', 'subscribe.cleanup.end', () => ({ revision }));
    };
  },
}));

export function useLocalLicenseLocked(): boolean {
  const accountStatus = useAccountStore((state) => state.status);
  const licenseState = useLicenseStore((state) => state.snapshot?.state);
  return accountStatus !== 'signedIn' && licenseState !== 'granted';
}
