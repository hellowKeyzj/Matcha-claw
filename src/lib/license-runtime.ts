import { hostCapabilityExecute } from '@/lib/host-api';
import type { RuntimeAddress } from '../../runtime-host/shared/runtime-address';

const LICENSE_RUNTIME_CAPABILITY_ID = 'license.runtime';

async function licenseRuntimeCapabilityExecute<TResult>(operationId: string, runtimeAddress: RuntimeAddress, input: Record<string, unknown> = {}): Promise<TResult> {
  return await hostCapabilityExecute<TResult>({
    id: LICENSE_RUNTIME_CAPABILITY_ID,
    operationId,
    runtimeAddress,
    input: {
      ...input,
      runtimeAddress,
    },
  });
}

export async function hostLicenseValidate<TResult>(key: string, runtimeAddress: RuntimeAddress): Promise<TResult> {
  return await licenseRuntimeCapabilityExecute<TResult>('license.validate', runtimeAddress, { key });
}

export async function hostLicenseRevalidate<TResult>(runtimeAddress: RuntimeAddress): Promise<TResult> {
  return await licenseRuntimeCapabilityExecute<TResult>('license.revalidate', runtimeAddress);
}

export async function hostLicenseClear(runtimeAddress: RuntimeAddress): Promise<{ success: boolean }> {
  return await licenseRuntimeCapabilityExecute<{ success: boolean }>('license.clear', runtimeAddress);
}
