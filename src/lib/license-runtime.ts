import { hostApiFetch } from '@/lib/host-api';
import { appScope } from '../../runtime-host/shared/runtime-address';

const LICENSE_RUNTIME_CAPABILITY_ID = 'license.runtime';

async function licenseRuntimeCapabilityExecute<TResult>(
  operationId: string,
  input: Record<string, unknown> = {},
  subject?: 'installation' | 'key' | 'gate',
): Promise<TResult> {
  return await hostApiFetch<TResult>('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify({
      id: LICENSE_RUNTIME_CAPABILITY_ID,
      operationId,
      scope: appScope(),
      target: { kind: 'license', ...(subject ? { subject } : {}) },
      input,
    }),
  });
}

export async function hostLicenseValidate<TResult>(key: string): Promise<TResult> {
  return await licenseRuntimeCapabilityExecute<TResult>('license.validate', { key }, 'key');
}

export async function hostLicenseRevalidate<TResult>(): Promise<TResult> {
  return await licenseRuntimeCapabilityExecute<TResult>('license.revalidate', {}, 'key');
}

export async function hostLicenseClear(): Promise<{ success: boolean }> {
  return await licenseRuntimeCapabilityExecute<{ success: boolean }>('license.clear', {}, 'key');
}
