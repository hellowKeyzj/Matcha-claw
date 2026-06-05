import type { LicenseService } from '../../license/service';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';

export const LICENSE_RUNTIME_CAPABILITY_ID = 'license.runtime';

export const licenseRuntimeCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'license.validate', title: 'Validate license' },
  { id: 'license.revalidate', title: 'Revalidate stored license' },
  { id: 'license.clear', title: 'Clear stored license' },
] as const;

export function createLicenseRuntimeCapabilityOperationRoutes(deps: {
  licenseService: Pick<LicenseService, 'validate' | 'revalidate' | 'clear'>;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: LICENSE_RUNTIME_CAPABILITY_ID,
      operationId: 'license.validate',
      handle: (context) => deps.licenseService.validate(context.domainInput),
    },
    {
      capabilityId: LICENSE_RUNTIME_CAPABILITY_ID,
      operationId: 'license.revalidate',
      handle: () => deps.licenseService.revalidate(),
    },
    {
      capabilityId: LICENSE_RUNTIME_CAPABILITY_ID,
      operationId: 'license.clear',
      handle: () => deps.licenseService.clear(),
    },
  ];
}

