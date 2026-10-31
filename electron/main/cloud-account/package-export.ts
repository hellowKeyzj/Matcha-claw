import type { CallReceipt } from '../../../src/types/call-log';
import { isSkillsCallReceipt, type SkillsRuntimeScope } from '../runtime-host-delivery/transport/skills/management';
import type { SealedSkillsTransport } from '../runtime-host-delivery/transport/skills/sealed';
import type { CloudSealedCloudKey } from './types';

export type SealedSkillPackageExportRequest = Readonly<{ skillKey: string; scope?: SkillsRuntimeScope }>;
export type SealedSkillPackageExport = Readonly<{
  status: number;
  body: CallReceipt | Readonly<{ success: false; error: string }>;
}>;

export async function exportSealedSkillPackage(
  request: SealedSkillPackageExportRequest,
  dependencies: Readonly<{
    fetchKey(): Promise<CloudSealedCloudKey>;
    exportCloud: SealedSkillsTransport['exportCloud'];
    bind(callId: string): void;
    release(): void;
  }>,
): Promise<SealedSkillPackageExport> {
  try {
    const cloudKey = await dependencies.fetchKey();
    const exported = await dependencies.exportCloud({
      skillKey: request.skillKey,
      cloudPublicKey: cloudKey.publicKey,
      cloudKeyId: cloudKey.keyId,
      ...(request.scope === undefined ? {} : { scope: request.scope }),
    });
    if (exported.status !== 202 || !isSkillsCallReceipt(exported.body)) {
      return {
        status: exported.status === 200 || exported.status === 202 ? 502 : exported.status,
        body: { success: false, error: runtimeExportError(exported.body, 'Skill package cloud export failed') },
      };
    }
    dependencies.bind(exported.body.callId);
    return { status: 202, body: exported.body };
  } finally {
    dependencies.release();
  }
}

function runtimeExportError(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const result = value as Record<string, unknown>;
  const detail = typeof result.reason === 'string' ? result.reason : typeof result.error === 'string' ? result.error : '';
  if (!detail || detail.length > 256 || detail.includes('\\') || detail.includes('/')) return fallback;
  return `${fallback}: ${detail}`;
}
