import { APP_SERVICE_MAX_BYTES, AppServiceError, isAppServiceRequest, type AppWorkspaceApi, type AppWorkspaceInputs, type AppWorkspaceResults } from '../../../sdk/app-plugins/src/services';
import { hasExactKeys, isRecord, isSafeNonNegativeInteger } from '../runtime-host-delivery/transport/client';
import type { RuntimeHostTransports } from '../runtime-host-delivery/transport/host-api-transports';
import { isEndpoint, isFileRelativePath } from '../runtime-host-delivery/transport/workspace/contract';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = 4 * 1024 * 1024;
type Operation = keyof AppWorkspaceInputs;
type Response = { readonly status: number; readonly body: unknown };

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppServiceError('cancelled', 'Workspace operation was cancelled.');
}

function unknownWrite(): AppServiceError {
  return new AppServiceError('outcome-unknown', 'Workspace write outcome is unknown; the file may already have changed.');
}

function binarySize(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_BINARY_BYTES / 3) * 4
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length <= MAX_BINARY_BYTES && bytes.toString('base64') === value ? bytes.length : null;
}

function requestInput(operation: Operation, value: unknown): { input: Record<string, unknown>; limit: number; writeSize?: number } {
  if (!isAppServiceRequest({ service: 'workspace', operation, input: value })
    || !isRecord(value) || !isEndpoint(value.endpoint)) {
    throw new AppServiceError('invalid-request', 'Workspace requests require a native local endpoint, an agent ID and a relative path.');
  }
  const input: Record<string, unknown> = {
    endpoint: { ...value.endpoint }, agentId: value.agentId, relativePath: value.relativePath,
  };
  const limit = operation === 'readBinary' || operation === 'writeBinary' ? MAX_BINARY_BYTES : MAX_TEXT_BYTES;
  if (operation === 'readText' || operation === 'readBinary') {
    const maxBytes = (value.maxBytes as number | undefined) ?? limit;
    return { input: { ...input, maxBytes }, limit: maxBytes };
  }
  if (operation === 'listDir') {
    input.includeHidden = value.includeHidden ?? false;
  } else if (operation === 'writeText') {
    input.content = value.content;
    return { input, limit, writeSize: Buffer.byteLength(value.content as string, 'utf8') };
  } else if (operation === 'writeBinary') {
    const size = binarySize(value.data);
    if (size === null) throw new AppServiceError('invalid-request', 'Workspace binary data must be canonical base64 encoding at most 4 MiB.');
    input.data = value.data;
    return { input, limit, writeSize: size };
  }
  return { input, limit };
}

function responseError(operation: Operation, response: Response): AppServiceError {
  const error = isRecord(response.body) && response.body.success === false ? response.body.error : null;
  switch (error) {
    case 'Workspace write outcome is unknown': return unknownWrite();
    case 'Workspace text path is invalid':
    case 'Workspace binary path is invalid':
    case 'Workspace directory path is invalid':
    case 'Workspace write path is invalid':
      return new AppServiceError('invalid-request', 'Workspace path is invalid.');
    case 'Workspace text target is not a file':
    case 'Workspace binary target is not a file':
    case 'Workspace write target is not a file':
      return new AppServiceError('not-found', 'Workspace target is not a file.');
    case 'Workspace directory target is not a directory':
      return new AppServiceError('not-found', 'Workspace target is not a directory.');
    case 'Workspace text target exceeds the limit':
    case 'Workspace binary target exceeds the limit':
    case 'Workspace write content exceeds the limit':
      return new AppServiceError('response-too-large', 'Workspace content exceeds the size limit.');
    case 'Workspace text target is binary':
      return new AppServiceError('invalid-request', 'Workspace file is not UTF-8 text.');
  }
  // The text transport collapses lost write responses and unavailable delivery into the same 503.
  return operation === 'writeText' || operation === 'writeBinary' && error !== 'Workspace write is unavailable'
    ? unknownWrite() : new AppServiceError('unavailable', 'Workspace operation is unavailable.');
}

function result<K extends Operation>(operation: K, body: unknown, limit: number, writeSize?: number): AppWorkspaceResults[K] {
  function valid(condition: unknown): asserts condition {
    if (!condition) throw writeSize === undefined ? new AppServiceError('unavailable', 'Workspace returned an invalid result.') : unknownWrite();
  }
  valid(isRecord(body));
  let output: unknown;
  if (operation === 'listDir') {
    valid(hasExactKeys(body, ['entries']) && Array.isArray(body.entries));
    output = { entries: body.entries.map((entry) => {
      if (!isRecord(entry) || !hasExactKeys(entry, ['relativePath', 'display', 'isDirectory', 'size'])
        || !isFileRelativePath(entry.relativePath) || !isFileRelativePath(entry.display)
        || typeof entry.isDirectory !== 'boolean' || !isSafeNonNegativeInteger(entry.size)) {
        throw new AppServiceError('unavailable', 'Workspace returned an invalid directory entry.');
      }
      return { relativePath: entry.relativePath, display: entry.display, isDirectory: entry.isDirectory, size: entry.size };
    }) };
  } else {
    valid(isFileRelativePath(body.name) && isSafeNonNegativeInteger(body.size));
    if (operation === 'readText') {
      valid(hasExactKeys(body, ['name', 'content', 'size']) && typeof body.content === 'string'
        && !body.content.includes('\0') && Buffer.byteLength(body.content, 'utf8') === body.size);
      output = { name: body.name, content: body.content, size: body.size };
    } else if (operation === 'readBinary') {
      if (isSafeNonNegativeInteger(body.size) && body.size > limit) {
        throw new AppServiceError('response-too-large', 'Workspace content exceeds the requested size limit.');
      }
      const size = binarySize(body.data);
      if (typeof body.data === 'string' && body.data.length > Math.ceil(MAX_BINARY_BYTES / 3) * 4) throw new AppServiceError('response-too-large', 'Workspace binary exceeds the 4 MiB limit.');
      valid(hasExactKeys(body, ['name', 'data', 'size']) && size !== null && size === body.size);
      output = { name: body.name, data: body.data, size: body.size };
    } else if (operation === 'stat') {
      valid(hasExactKeys(body, ['name', 'isDirectory', 'size', 'mtimeMs'])
        && typeof body.isDirectory === 'boolean' && isSafeNonNegativeInteger(body.mtimeMs));
      output = { name: body.name, isDirectory: body.isDirectory, size: body.size, mtimeMs: body.mtimeMs };
    } else {
      valid(hasExactKeys(body, ['name', 'size']) && body.size === writeSize);
      output = { name: body.name, size: body.size };
    }
    if ((operation === 'readText' || operation === 'readBinary') && (body.size as number) > limit) {
      throw new AppServiceError('response-too-large', 'Workspace content exceeds the requested size limit.');
    }
  }
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > APP_SERVICE_MAX_BYTES) throw new AppServiceError('response-too-large', 'Workspace result exceeds the 8 MiB limit.');
  return output as AppWorkspaceResults[K];
}

export function createAppPluginWorkspace(getTransports: () => Promise<RuntimeHostTransports>): AppWorkspaceApi {
  async function execute<K extends Operation>(operation: K, value: AppWorkspaceInputs[K], signal?: AbortSignal): Promise<AppWorkspaceResults[K]> {
    cancelled(signal);
    const { input, limit, writeSize } = requestInput(operation, value);
    let transports: RuntimeHostTransports;
    try { transports = await getTransports(); } catch {
      cancelled(signal);
      throw new AppServiceError('unavailable', 'Workspace runtime is unavailable.');
    }
    cancelled(signal);
    const request = {
      id: 'workspace.file', operationId: `files.${operation}`,
      scope: { kind: 'agent', endpoint: input.endpoint, agentId: input.agentId },
      target: { kind: 'workspace-file' }, input,
    };
    let response: Response;
    try {
      switch (operation) {
        case 'readText': response = await transports.workspaceTextTransport.read(request); break;
        case 'readBinary':
        case 'stat': response = await transports.workspaceBinaryTransport.execute(request); break;
        case 'listDir': response = await transports.workspaceDirectoryTransport.list(request); break;
        case 'writeText': response = await transports.workspaceWriteTransport.write(request); break;
        case 'writeBinary': response = await transports.workspaceWriteBinaryTransport.write(request); break;
        default: throw new AppServiceError('invalid-request', 'Workspace operation is invalid.');
      }
    } catch {
      if (writeSize !== undefined) throw unknownWrite();
      cancelled(signal);
      throw new AppServiceError('unavailable', 'Workspace operation is unavailable.');
    }
    if (signal?.aborted && writeSize !== undefined) throw unknownWrite();
    cancelled(signal);
    if (response.status !== 200) throw responseError(operation, response);
    return result(operation, response.body, limit, writeSize);
  }
  return {
    readText: (input, signal) => execute('readText', input, signal),
    readBinary: (input, signal) => execute('readBinary', input, signal),
    stat: (input, signal) => execute('stat', input, signal),
    listDir: (input, signal) => execute('listDir', input, signal),
    writeText: (input, signal) => execute('writeText', input, signal),
    writeBinary: (input, signal) => execute('writeBinary', input, signal),
  };
}
