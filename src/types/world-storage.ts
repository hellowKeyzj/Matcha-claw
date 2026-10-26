import type { WorldRef } from './world';
import type { InitialWorldIssue } from './world-initial';

export type StorageOpenInput = { connectionString: string };
export type StorageOpenResult =
  | { outcome: 'opened'; storageId: string; worlds: WorldRef[] }
  | { outcome: 'not-configured' }
  | { outcome: 'not-attempted'; error: InitialWorldIssue }
  | { outcome: 'unknown'; error: InitialWorldIssue; world?: WorldRef; commitId?: string };
