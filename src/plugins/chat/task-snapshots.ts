import { useTaskSnapshotStore } from './store/task-snapshot-store';
import type { TaskSnapshotEvent } from '@/types/session/task-snapshot';

export function reportTaskCenterSnapshot(event: TaskSnapshotEvent & { recordKey?: string }): void {
  useTaskSnapshotStore.getState().reportTaskCenterSnapshot(event);
}
