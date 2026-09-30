import type {} from '../call-log';

/** Installed catalog entries do not assert lease validity, native enablement or run success. */
export interface SealedResourceCallDetail {
  packageSha256: string | null;
  authorization: 'valid' | 'invalid' | 'cleared' | null;
  packageCount: number | null;
  packages: Array<{
    packageType: 'skill' | 'agent';
    packageVersionId: string | null;
    packageSha256: string;
  }>;
  error: 'alreadyExists' | 'notFound' | 'rejected' | 'outcomeUnknown' | 'auditUnavailable' | null;
}

declare module '../call-log' {
  interface CallDetailByModule {
    'sealed-resource': SealedResourceCallDetail;
  }
}

export function decodeSealedResourceCallDetail(value: unknown): SealedResourceCallDetail | null {
  if (!isRecord(value)
    || !hasKeys(value, ['packageSha256', 'authorization', 'packageCount', 'packages', 'error'])
    || (value.packageSha256 !== null && !isDigest(value.packageSha256))
    || ![null, 'valid', 'invalid', 'cleared'].includes(value.authorization as string | null)
    || (value.packageCount !== null && (typeof value.packageCount !== 'number'
      || !Number.isSafeInteger(value.packageCount) || value.packageCount < 0))
    || !Array.isArray(value.packages) || value.packages.length > 8
    || ![null, 'alreadyExists', 'notFound', 'rejected', 'outcomeUnknown', 'auditUnavailable'].includes(value.error as string | null)
  ) return null;
  const packages: SealedResourceCallDetail['packages'] = [];
  for (const entry of value.packages) {
    if (!isRecord(entry) || !hasKeys(entry, ['packageType', 'packageVersionId', 'packageSha256'])
      || (entry.packageType !== 'skill' && entry.packageType !== 'agent')
      || (entry.packageVersionId !== null && (typeof entry.packageVersionId !== 'string'
        || entry.packageVersionId.length === 0 || entry.packageVersionId.length > 256
        || /[^a-zA-Z0-9._-]/.test(entry.packageVersionId)))
      || !isDigest(entry.packageSha256)
    ) return null;
    packages.push({ packageType: entry.packageType, packageVersionId: entry.packageVersionId, packageSha256: entry.packageSha256 });
  }
  if ((value.packageCount === null && packages.length !== 0)
    || (typeof value.packageCount === 'number' && packages.length > value.packageCount)) return null;
  return {
    packageSha256: value.packageSha256 as string | null,
    authorization: value.authorization as SealedResourceCallDetail['authorization'],
    packageCount: value.packageCount as number | null,
    packages,
    error: value.error as SealedResourceCallDetail['error'],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && !/[^a-fA-F0-9]/.test(value);
}
