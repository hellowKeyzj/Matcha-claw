import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hostFileListDir } from '@/lib/host-api';
import type { SessionIdentity } from '../types/desktop/runtime-address';

export type WorkspaceAvailability = 'checking' | 'available' | 'unavailable';

export type WorkspaceAvailabilityTarget = Readonly<{
  key: string;
  path: string;
  sessionIdentity: SessionIdentity | null | undefined;
}>;

type BoundWorkspaceAvailabilityTarget = Readonly<{
  key: string;
  path: string;
  sessionIdentity: SessionIdentity;
}>;

const MAX_CONCURRENT_CHECKS = 4;
const WORKSPACE_AVAILABILITY_TIMEOUT_MS = 15_000;

export function useWorkspaceAvailability(
  targets: readonly WorkspaceAvailabilityTarget[],
): Record<string, WorkspaceAvailability> {
  const entriesKey = useMemo(() => uniqueEntries(targets).map(serializeEntry).join('\0'), [targets]);
  const entries = useMemo(() => (entriesKey ? entriesKey.split('\0').map(deserializeEntry) : []), [entriesKey]);
  const [availability, setAvailability] = useState<Record<string, WorkspaceAvailability>>({});
  const generationRef = useRef(0);

  const validate = useCallback(async () => {
    const generation = ++generationRef.current;
    setAvailability((current) => {
      const next: Record<string, WorkspaceAvailability> = {};
      for (const entry of entries) next[entry.key] = current[entry.key] ?? 'checking';
      return next;
    });

    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_CHECKS, entries.length) },
      async () => {
        while (nextIndex < entries.length) {
          const entry = entries[nextIndex++];
          if (!entry) continue;
          const status = await checkWorkspace(entry.sessionIdentity);
          if (generationRef.current !== generation) return;
          setAvailability((current) => (
            current[entry.key] === status ? current : { ...current, [entry.key]: status }
          ));
        }
      },
    );
    await Promise.all(workers);
  }, [entries]);

  useEffect(() => {
    void validate();
    const handleFocus = () => void validate();
    window.addEventListener('focus', handleFocus);
    return () => {
      generationRef.current += 1;
      window.removeEventListener('focus', handleFocus);
    };
  }, [validate]);

  return availability;
}

function uniqueEntries(targets: readonly WorkspaceAvailabilityTarget[]): BoundWorkspaceAvailabilityTarget[] {
  const entries = new Map<string, BoundWorkspaceAvailabilityTarget>();
  for (const target of targets) {
    const key = target.key.trim();
    if (!key || !target.sessionIdentity) continue;
    entries.set(key, {
      key,
      path: target.path.trim(),
      sessionIdentity: target.sessionIdentity,
    });
  }
  return [...entries.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function serializeEntry(entry: BoundWorkspaceAvailabilityTarget): string {
  return JSON.stringify(entry);
}

function deserializeEntry(value: string): BoundWorkspaceAvailabilityTarget {
  return JSON.parse(value) as BoundWorkspaceAvailabilityTarget;
}

async function checkWorkspace(sessionIdentity: SessionIdentity): Promise<WorkspaceAvailability> {
  try {
    const result = await hostFileListDir({
      endpoint: sessionIdentity.endpoint,
      sessionKey: sessionIdentity.sessionKey,
      relativePath: '',
    }, { timeoutMs: WORKSPACE_AVAILABILITY_TIMEOUT_MS });
    return result.ok ? 'available' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
