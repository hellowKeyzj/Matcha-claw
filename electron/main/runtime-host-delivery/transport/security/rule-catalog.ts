import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

const UNAVAILABLE = {
  success: false,
  error: 'Security rule catalog is unavailable',
} as const;

const CATALOG_PATH = '/api/security/destructive-rule-catalog/current';
const MAX_CATALOG_ITEMS = 22;
const MAX_CATALOG_TEXT_LENGTH = 4096;
const CATALOG_ITEM_FIELDS = ['platform', 'command', 'category', 'severity', 'reason'] as const;

export type SecurityRuleCatalogPlatform =
  | 'universal'
  | 'linux'
  | 'windows'
  | 'macos'
  | 'powershell';

export type SecurityRuleCatalogCategory =
  | 'file_delete'
  | 'git_destructive'
  | 'sql_destructive'
  | 'system_destructive'
  | 'process_kill'
  | 'network_destructive'
  | 'privilege_escalation';

export type SecurityRuleCatalogSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type SecurityRuleCatalogItem = Readonly<{
  platform: SecurityRuleCatalogPlatform;
  command: string;
  category: SecurityRuleCatalogCategory;
  severity: SecurityRuleCatalogSeverity;
  reason: string;
}>;

export type SecurityRuleCatalogResponse = Readonly<{
  success: true;
  total: number;
  items: readonly SecurityRuleCatalogItem[];
}>;

export type SecurityRuleCatalogTransportResponse = Readonly<{
  status: 200;
  body: SecurityRuleCatalogResponse;
}> | Readonly<{
  status: 503;
  body: typeof UNAVAILABLE;
}>;

export interface SecurityRuleCatalogTransport {
  read(platform?: string | null): Promise<SecurityRuleCatalogTransportResponse>;
}

export function createSecurityRuleCatalogTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SecurityRuleCatalogTransport {
  return {
    async read(platform?: string | null): Promise<SecurityRuleCatalogTransportResponse> {
      const path = platform === undefined || platform === null
        ? CATALOG_PATH
        : `${CATALOG_PATH}?platform=${encodeURIComponent(platform)}`;
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path,
        issuer,
        decision: {
          endpoint: CATALOG_PATH,
          scope: 'security:read',
          capability: 'security.rule-catalog.read',
          subject: 'security-rule-catalog',
        },
        method: 'GET',
        fetcher,
      });
      if (response?.status === 200 && isSecurityRuleCatalogResponse(response.body)) {
        return { status: 200, body: projectSecurityRuleCatalog(response.body) };
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isSecurityRuleCatalogResponse(value: unknown): value is SecurityRuleCatalogResponse {
  if (!isRecord(value) || !hasExactKeys(value, ['success', 'total', 'items'])) return false;
  return value.success === true
    && isSafeInteger(value.total)
    && value.total >= 0
    && value.total <= MAX_CATALOG_ITEMS
    && Array.isArray(value.items)
    && value.items.length === value.total
    && value.items.every(isSecurityRuleCatalogItem);
}

function isSecurityRuleCatalogItem(value: unknown): value is SecurityRuleCatalogItem {
  return isRecord(value)
    && hasExactKeys(value, CATALOG_ITEM_FIELDS)
    && isSecurityRuleCatalogPlatform(value.platform)
    && isSecurityCatalogText(value.command)
    && isSecurityRuleCatalogCategory(value.category)
    && isSecurityCatalogSeverity(value.severity)
    && isSecurityCatalogText(value.reason);
}

function projectSecurityRuleCatalog(value: SecurityRuleCatalogResponse): SecurityRuleCatalogResponse {
  return {
    success: true,
    total: value.total,
    items: value.items.map((item) => ({
      platform: item.platform,
      command: item.command,
      category: item.category,
      severity: item.severity,
      reason: item.reason,
    })),
  };
}

function isSecurityRuleCatalogPlatform(value: unknown): value is SecurityRuleCatalogPlatform {
  return value === 'universal'
    || value === 'linux'
    || value === 'windows'
    || value === 'macos'
    || value === 'powershell';
}

function isSecurityRuleCatalogCategory(value: unknown): value is SecurityRuleCatalogCategory {
  return value === 'file_delete'
    || value === 'git_destructive'
    || value === 'sql_destructive'
    || value === 'system_destructive'
    || value === 'process_kill'
    || value === 'network_destructive'
    || value === 'privilege_escalation';
}

function isSecurityCatalogSeverity(value: unknown): value is SecurityRuleCatalogSeverity {
  return value === 'critical'
    || value === 'high'
    || value === 'medium'
    || value === 'low'
    || value === 'info';
}

function isSecurityCatalogText(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_CATALOG_TEXT_LENGTH
    && ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    });
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
