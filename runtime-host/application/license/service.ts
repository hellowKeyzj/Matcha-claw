import type { ParentShellAction, ParentTransportUpstreamPayload } from '../../api/dispatch/parent-transport';

type LocalDispatchResponse = {
  status: number;
  data: unknown;
};

export interface LicenseServiceDeps {
  readonly requestParentShellAction: (action: ParentShellAction, payload?: unknown) => Promise<ParentTransportUpstreamPayload>;
  readonly mapParentTransportResponse: (upstream: ParentTransportUpstreamPayload) => LocalDispatchResponse;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class LicenseService {
  constructor(private readonly deps: LicenseServiceDeps) {}

  async gate() {
    return this.deps.mapParentTransportResponse(
      await this.deps.requestParentShellAction('license_get_gate'),
    );
  }

  async storedKey() {
    return this.deps.mapParentTransportResponse(
      await this.deps.requestParentShellAction('license_get_stored_key'),
    );
  }

  async validate(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    return this.deps.mapParentTransportResponse(
      await this.deps.requestParentShellAction('license_validate', {
        key: typeof body.key === 'string' ? body.key : '',
      }),
    );
  }

  async revalidate() {
    return this.deps.mapParentTransportResponse(
      await this.deps.requestParentShellAction('license_revalidate'),
    );
  }

  async clear() {
    return this.deps.mapParentTransportResponse(
      await this.deps.requestParentShellAction('license_clear'),
    );
  }
}
