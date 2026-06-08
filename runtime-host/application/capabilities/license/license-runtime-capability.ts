import type { LicenseService } from '../../license/service';
import { badRequest } from '../../common/application-response';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute, CapabilityOperationContext } from '../contracts/capability-router';

export const LICENSE_RUNTIME_CAPABILITY_ID = 'license.runtime';

export const licenseRuntimeCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'license.validate', title: 'Validate license', targetKind: 'license' },
  { id: 'license.revalidate', title: 'Revalidate stored license', targetKind: 'license' },
  { id: 'license.clear', title: 'Clear stored license', targetKind: 'license' },
] as const;

export function createLicenseRuntimeCapabilityOperationRoutes(deps: {
  licenseService: Pick<LicenseService, 'validate' | 'revalidate' | 'clear'>;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: LICENSE_RUNTIME_CAPABILITY_ID,
      operationId: 'license.validate',
      handle: (context) => {
        const targetError = requireLicenseTargetSubject(context, 'key');
        return targetError ? badRequest(targetError) : deps.licenseService.validate(context.domainInput);
      },
    },
    {
      capabilityId: LICENSE_RUNTIME_CAPABILITY_ID,
      operationId: 'license.revalidate',
      handle: (context) => {
        const targetError = requireLicenseTargetSubject(context, 'key');
        return targetError ? badRequest(targetError) : deps.licenseService.revalidate();
      },
    },
    {
      capabilityId: LICENSE_RUNTIME_CAPABILITY_ID,
      operationId: 'license.clear',
      handle: (context) => {
        const targetError = requireLicenseTargetSubject(context, 'key');
        return targetError ? badRequest(targetError) : deps.licenseService.clear();
      },
    },
  ];
}

function requireLicenseTargetSubject(
  context: CapabilityOperationContext,
  subject: 'installation' | 'key' | 'gate',
): string | null {
  return context.target?.kind === 'license' && context.target.subject === subject
    ? null
    : `Capability target subject must be ${subject}`;
}

