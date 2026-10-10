import type { LicenseGateSnapshot } from './service';
import { LicenseService } from './service';
import { NodeLicenseRuntime } from './node-runtime';

export function composeLicenseService(deps?: {
  onGateChanged?: (snapshot: LicenseGateSnapshot) => void;
}): LicenseService {
  return new LicenseService(new NodeLicenseRuntime({ onGateChanged: deps?.onGateChanged }));
}
