import type { ReconcileReport } from './models';

export interface ReconcilerPort {
  reconcileTools(): Promise<ReconcileReport>;
}
