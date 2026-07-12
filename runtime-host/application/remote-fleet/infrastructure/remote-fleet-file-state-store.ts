import path from 'node:path';
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import {
  deserializeRemoteFleetPersistedState,
  type RemoteFleetPersistedState,
  type RemoteFleetStateStore,
} from '../remote-fleet-store';

export class FileRemoteFleetStateStore implements RemoteFleetStateStore {
  private readonly statePath: string;

  constructor(input: {
    readonly runtimeDataRootDir: string;
  }) {
    this.statePath = path.join(input.runtimeDataRootDir, 'remote-fleet', 'state.json');
  }

  async readState(): Promise<RemoteFleetPersistedState | null> {
    try {
      const text = await readFile(this.statePath, 'utf8');
      return deserializeRemoteFleetPersistedState(JSON.parse(text));
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async writeState(state: RemoteFleetPersistedState): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.statePath);
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT';
}
