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

export async function handleE2EHostApiFetch(
  _request: HostApiFetchRequest,
): Promise<HostApiProxyEnvelope | null> {
  return null;
}

export async function getE2EDialogOpenResult(): Promise<{ canceled: boolean; filePaths: string[] } | null> {
  return null;
}

export async function getE2EDialogStagedAttachments(): Promise<{
  stagedAttachmentId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;
}[] | null> {
  return null;
}

export async function getE2EDiagnosticsArchiveSavePath(): Promise<string | null> {
  return null;
}

export async function getE2EGatewayStatus<TStatus>(): Promise<TStatus | null> {
  return null;
}
