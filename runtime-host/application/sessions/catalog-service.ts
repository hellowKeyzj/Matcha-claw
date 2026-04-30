import { access, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { listIndexedSessions, readSessionsIndex } from './session-index';
import {
  parseTranscriptMessages,
  resolveTranscriptSessionLabel,
} from './transcript-utils';

interface SessionCatalogServiceDeps {
  getOpenClawConfigDir: () => string;
}

interface SessionCatalogItem {
  key: string;
  label?: string;
  displayName?: string;
  updatedAt?: number;
}

async function listAgentIds(configDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(configDir, 'agents'), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.trim().length > 0)
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export class SessionCatalogService {
  constructor(private readonly deps: SessionCatalogServiceDeps) {}

  async list() {
    const configDir = this.deps.getOpenClawConfigDir();
    const agentIds = await listAgentIds(configDir);
    const sessions: SessionCatalogItem[] = [];

    for (const agentId of agentIds) {
      const sessionsDir = join(configDir, 'agents', agentId, 'sessions');
      const sessionsJson = await readSessionsIndex(join(sessionsDir, 'sessions.json'));
      const indexedSessions = listIndexedSessions(sessionsJson, sessionsDir);

      for (const entry of indexedSessions) {
        const transcriptPath = entry.transcriptPath ?? join(
          sessionsDir,
          `${entry.sessionKey.split(':').slice(2).join(':')}.jsonl`,
        );
        try {
          await access(transcriptPath);
        } catch {
          continue;
        }

        let label: string | undefined;
        let updatedAt: number | undefined;
        try {
          const content = await readFile(transcriptPath, 'utf8');
          const messages = parseTranscriptMessages(content);
          const resolvedLabel = resolveTranscriptSessionLabel(messages);
          if (resolvedLabel) {
            label = resolvedLabel;
          }
          const lastTimestamp = messages[messages.length - 1]?.timestamp;
          if (typeof lastTimestamp === 'number' && Number.isFinite(lastTimestamp)) {
            updatedAt = lastTimestamp;
          }
        } catch {
          void 0;
        }

        if (typeof updatedAt !== 'number') {
          try {
            updatedAt = (await stat(transcriptPath)).mtimeMs;
          } catch {
            updatedAt = undefined;
          }
        }

        sessions.push({
          key: entry.sessionKey,
          ...(label ? { label } : {}),
          displayName: entry.sessionKey,
          ...(typeof updatedAt === 'number' ? { updatedAt } : {}),
        });
      }
    }

    sessions.sort((left, right) => {
      const leftUpdatedAt = typeof left.updatedAt === 'number' ? left.updatedAt : 0;
      const rightUpdatedAt = typeof right.updatedAt === 'number' ? right.updatedAt : 0;
      if (leftUpdatedAt !== rightUpdatedAt) {
        return rightUpdatedAt - leftUpdatedAt;
      }
      return left.key.localeCompare(right.key);
    });

    return {
      status: 200,
      data: { sessions },
    };
  }
}
