import { join } from 'node:path';

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
  stagedAttachmentId?: string;
  entryKind?: 'file' | 'directory';
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;
  sourcePath?: string;
};

export async function handleE2EHostApiFetch(
  _request: HostApiFetchRequest,
): Promise<HostApiProxyEnvelope | null> {
  return null;
}

export async function getE2EDialogOpenResult(): Promise<{ canceled: boolean; filePaths: string[] } | null> {
  return null;
}

export async function getE2EDialogStagedAttachments(): Promise<E2EDialogStagedAttachmentPayload[] | null> {
  return null;
}

export async function getE2EDiagnosticsArchiveSavePath(): Promise<string | null> {
  const configured = process.env.MATCHACLAW_E2E_DIAGNOSTICS_SAVE_PATH?.trim();
  const userDataDir = process.env.MATCHACLAW_E2E_USER_DATA_DIR?.trim();
  return configured || (process.env.MATCHACLAW_E2E === '1' && userDataDir
    ? join(userDataDir, 'diagnostics-archive.zip')
    : null);
}

export async function getE2EGatewayStatus<TStatus>(): Promise<TStatus | null> {
  return null;
}
