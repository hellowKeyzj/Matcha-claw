import type { SessionExternalArtefactResolverPort } from '../../../sessions/session-storage-repository';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export class OpenClawSessionArtefactResolver implements SessionExternalArtefactResolverPort {
  resolveExternalArtefactPaths(input: { pointerContent: string }): readonly string[] {
    try {
      const parsed = JSON.parse(input.pointerContent) as unknown;
      if (!isRecord(parsed) || parsed.traceSchema !== 'openclaw-trajectory-pointer') {
        return [];
      }
      if (parsed.schemaVersion !== 1) {
        return [];
      }
      const sessionId = normalizeString(parsed.sessionId);
      if (!sessionId) {
        return [];
      }
      const runtimeFile = normalizeString(parsed.runtimeFile);
      return runtimeFile.endsWith('.jsonl') ? [runtimeFile] : [];
    } catch {
      return [];
    }
  }
}
