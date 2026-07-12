type HostApiFetchRequest = {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
};

type HostApiProxyEnvelope =
  | {
    ok: true;
    data: {
      status: number;
      ok: boolean;
      json?: unknown;
      text?: string;
    };
  }
  | {
    ok: false;
    error: { message: string };
  };

export type E2EDialogStagedAttachmentPayload = {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  stagedPath: string;
  preview: string | null;
};

type E2EFixtureModule = {
  handleE2EHostApiFetch: (request: HostApiFetchRequest) => HostApiProxyEnvelope | null;
  getE2EDialogOpenResult: () => { canceled: boolean; filePaths: string[] } | null;
  getE2EDialogStagedAttachments: () => E2EDialogStagedAttachmentPayload[] | null;
  getE2EGatewayStatus: () => unknown | null;
};

let fixtureModulePromise: Promise<E2EFixtureModule | null> | null = null;

function isE2EEnabled(): boolean {
  return process.env.MATCHACLAW_E2E === '1';
}

async function loadFixtureModule(): Promise<E2EFixtureModule | null> {
  if (!isE2EEnabled()) {
    return null;
  }
  if (!fixtureModulePromise) {
    fixtureModulePromise = import('../../tests/e2e/fixtures/host-api-fixture') as Promise<E2EFixtureModule>;
  }
  return await fixtureModulePromise;
}

export async function handleE2EHostApiFetch(
  request: HostApiFetchRequest,
): Promise<HostApiProxyEnvelope | null> {
  return (await loadFixtureModule())?.handleE2EHostApiFetch(request) ?? null;
}

export async function getE2EDialogOpenResult(): Promise<{ canceled: boolean; filePaths: string[] } | null> {
  return (await loadFixtureModule())?.getE2EDialogOpenResult() ?? null;
}

export async function getE2EDialogStagedAttachments(): Promise<E2EDialogStagedAttachmentPayload[] | null> {
  return (await loadFixtureModule())?.getE2EDialogStagedAttachments() ?? null;
}

export async function getE2EGatewayStatus<TStatus>(): Promise<TStatus | null> {
  return ((await loadFixtureModule())?.getE2EGatewayStatus() ?? null) as TStatus | null;
}
