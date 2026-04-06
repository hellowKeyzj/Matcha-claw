import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { normalizeSecurityPolicyPayload, type SecurityPolicyPayload } from './security-policy-rules';

function getOpenClawConfigDir(): string {
  return process.env.OPENCLAW_CONFIG_DIR?.trim() || join(homedir(), '.openclaw');
}

function getSecurityPolicyDir(): string {
  return join(getOpenClawConfigDir(), 'policies');
}

export function getSecurityPolicyFilePath(): string {
  return join(getSecurityPolicyDir(), 'security.policy.json');
}

function readPolicyFile(filePath: string): SecurityPolicyPayload | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeSecurityPolicyPayload(parsed);
  } catch {
    return null;
  }
}

export function readSecurityPolicyFromFile(): SecurityPolicyPayload {
  const preferred = readPolicyFile(getSecurityPolicyFilePath());
  if (preferred) {
    return preferred;
  }
  return normalizeSecurityPolicyPayload({});
}

export function writeSecurityPolicyToFile(payload: unknown): SecurityPolicyPayload {
  const normalized = normalizeSecurityPolicyPayload(payload);
  mkdirSync(getSecurityPolicyDir(), { recursive: true });
  writeFileSync(getSecurityPolicyFilePath(), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}
