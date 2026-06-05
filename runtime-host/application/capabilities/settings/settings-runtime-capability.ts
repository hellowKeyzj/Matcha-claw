import type { SettingsService } from '../../settings/service';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';

export const SETTINGS_RUNTIME_CAPABILITY_ID = 'settings.runtime';

export const settingsRuntimeCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'settings.patch', title: 'Patch runtime settings' },
  { id: 'settings.reset', title: 'Reset runtime settings' },
  { id: 'settings.setValue', title: 'Set runtime setting value' },
] as const;

export function createSettingsRuntimeCapabilityOperationRoutes(deps: {
  settingsService: Pick<SettingsService, 'patch' | 'reset' | 'setValue'>;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: SETTINGS_RUNTIME_CAPABILITY_ID,
      operationId: 'settings.patch',
      handle: (context) => deps.settingsService.patch(context.domainInput),
    },
    {
      capabilityId: SETTINGS_RUNTIME_CAPABILITY_ID,
      operationId: 'settings.reset',
      handle: (context) => deps.settingsService.reset(context.address),
    },
    {
      capabilityId: SETTINGS_RUNTIME_CAPABILITY_ID,
      operationId: 'settings.setValue',
      handle: (context) => {
        const body = context.domainInput;
        return deps.settingsService.setValue(readString(body.key), body.value);
      },
    },
  ];
}


function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
