import { promises as fsPromises } from 'node:fs';
import { ensureParentDir, getProviderStoreFilePath } from './paths';

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function readProviderStoreLocal() {
  const filePath = getProviderStoreFilePath();
  try {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return {
        schemaVersion: 1,
        defaultAccountId: null,
        accounts: {},
        apiKeys: {},
      };
    }
    return {
      schemaVersion: 1,
      defaultAccountId: typeof parsed.defaultAccountId === 'string' ? parsed.defaultAccountId : null,
      accounts: isRecord(parsed.accounts) ? parsed.accounts : {},
      apiKeys: isRecord(parsed.apiKeys) ? parsed.apiKeys : {},
    };
  } catch {
    return {
      schemaVersion: 1,
      defaultAccountId: null,
      accounts: {},
      apiKeys: {},
    };
  }
}

export async function writeProviderStoreLocal(store: unknown) {
  const filePath = getProviderStoreFilePath();
  await ensureParentDir(filePath);
  await fsPromises.writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}
