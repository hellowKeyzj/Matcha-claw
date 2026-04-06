import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

type OpenClawConfigObject = Record<string, unknown>;

export function getOpenClawConfigDirPath(): string {
  return process.env.OPENCLAW_CONFIG_DIR?.trim() || join(homedir(), '.openclaw');
}

export function getOpenClawConfigFilePath(): string {
  return join(getOpenClawConfigDirPath(), 'openclaw.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function readOpenClawConfigJson(): OpenClawConfigObject {
  const configPath = getOpenClawConfigFilePath();
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
