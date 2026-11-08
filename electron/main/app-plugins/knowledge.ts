import {
  APP_SERVICE_MAX_BYTES, AppServiceError, isAppServiceRequest,
  type AppKnowledgeApi, type AppKnowledgeArchive, type AppKnowledgeHit,
  type AppKnowledgeInputs, type AppKnowledgeProcessingState, type AppKnowledgeResults,
} from '../../../sdk/app-plugins/src/services';
import { hasExactKeys, isNonEmptyBoundedText, isRecord, isSafeNonNegativeInteger } from '../runtime-host-delivery/transport/client';
import type { RuntimeHostTransports } from '../runtime-host-delivery/transport/host-api-transports';
import { isFileRelativePath } from '../runtime-host-delivery/transport/workspace/contract';
import { requirePluginId } from './package';

type Operation = keyof AppKnowledgeInputs;
type Response = { readonly status: number; readonly body: unknown };

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppServiceError('cancelled', 'Knowledge operation was cancelled.');
}

function unknownArchive(): AppServiceError {
  return new AppServiceError('outcome-unknown', 'Knowledge archive may already be saved; query archiveStatus with the same request key before deciding what to do next.');
}

function invalidResult(): AppServiceError {
  return new AppServiceError('unavailable', 'Knowledge returned an invalid result.');
}

function boundedJson(value: unknown, request = false): string {
  let json: string;
  try { json = JSON.stringify(value); } catch {
    throw new AppServiceError(request ? 'invalid-request' : 'unavailable', 'Knowledge payload must be JSON serializable.');
  }
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > APP_SERVICE_MAX_BYTES) {
    throw new AppServiceError(request ? 'invalid-request' : 'response-too-large', 'Knowledge JSON exceeds the 8 MiB limit.');
  }
  return json;
}

function relativePath(value: unknown): value is string {
  return isFileRelativePath(value) && !value.includes('\\');
}

function processingState(value: unknown): value is AppKnowledgeProcessingState {
  return value === 'pending' || value === 'running' || value === 'completed' || value === 'failed'
    || value === 'cancelled' || value === 'unsupported' || value === 'unknown';
}

function projects(body: unknown): AppKnowledgeResults['list'] {
  if (!isRecord(body) || !Array.isArray(body.projects)) throw invalidResult();
  return { projects: body.projects.map((project) => {
    if (!isRecord(project) || !isNonEmptyBoundedText(project.projectId) || typeof project.title !== 'string'
      || typeof project.isCurrent !== 'boolean') throw invalidResult();
    return { projectId: project.projectId, title: project.title, isCurrent: project.isCurrent };
  }) };
}

function listDir(body: unknown, input: AppKnowledgeInputs['listDir']): AppKnowledgeResults['listDir'] {
  if (!isRecord(body) || body.root !== input.relativePath || !Array.isArray(body.entries)) throw invalidResult();
  const entries = body.entries.map((entry) => {
    if (!isRecord(entry) || !relativePath(entry.relativePath) || typeof entry.isDirectory !== 'boolean'
      || !isSafeNonNegativeInteger(entry.size) || !isSafeNonNegativeInteger(entry.modifiedAtMs)
      || (input.relativePath ? !entry.relativePath.startsWith(`${input.relativePath}/`) : false)
      || entry.relativePath.slice(input.relativePath.length + (input.relativePath ? 1 : 0)).includes('/')) throw invalidResult();
    return { relativePath: entry.relativePath, isDirectory: entry.isDirectory, size: entry.size, modifiedAtMs: entry.modifiedAtMs };
  });
  return { projectId: input.projectId, relativePath: input.relativePath, entries };
}

function read(body: unknown, input: AppKnowledgeInputs['read']): AppKnowledgeResults['read'] {
  if (!isRecord(body) || body.relativePath !== input.relativePath || typeof body.content !== 'string'
    || !isRecord(body.revision) || !isNonEmptyBoundedText(body.revision.id)
    || !isSafeNonNegativeInteger(body.revision.size) || !isSafeNonNegativeInteger(body.revision.modifiedAtMs)
    || Buffer.byteLength(body.content, 'utf8') !== body.revision.size) throw invalidResult();
  return {
    projectId: input.projectId, relativePath: input.relativePath, content: body.content,
    revision: { id: body.revision.id, size: body.revision.size, modifiedAtMs: body.revision.modifiedAtMs },
  };
}

function search(body: unknown, input: AppKnowledgeInputs['search']): AppKnowledgeResults['search'] {
  if (!isRecord(body) || body.query !== input.query || !Array.isArray(body.hits)) throw invalidResult();
  const hits = body.hits.map((hit): AppKnowledgeHit => {
    if (!isRecord(hit) || !relativePath(hit.relativePath) || typeof hit.title !== 'string'
      || typeof hit.score !== 'number' || !Number.isFinite(hit.score) || !Array.isArray(hit.snippets)
      || !hit.snippets.every((snippet): snippet is string => typeof snippet === 'string')
      || !(hit.content === null || typeof hit.content === 'string')) throw invalidResult();
    return {
      relativePath: hit.relativePath, title: hit.title, score: hit.score,
      snippets: [...hit.snippets], content: hit.content,
    };
  });
  return { projectId: input.projectId, query: input.query, hits };
}

function archive(body: unknown, input: AppKnowledgeInputs['archiveStatus']): AppKnowledgeArchive {
  if (!isRecord(body) || !hasExactKeys(body, ['archiveId', 'projectId', 'requestKey', 'title', 'sourceUrl', 'callId', 'accepted', 'saveState', 'files'])
    || !isNonEmptyBoundedText(body.archiveId) || body.projectId !== input.projectId || body.requestKey !== input.requestKey
    || typeof body.title !== 'string' || !(body.sourceUrl === null || typeof body.sourceUrl === 'string')
    || !isNonEmptyBoundedText(body.callId) || body.accepted !== true || body.saveState !== 'saved'
    || !Array.isArray(body.files) || body.files.length === 0) throw invalidResult();
  const files = body.files.map((file): AppKnowledgeArchive['files'][number] => {
    if (!isRecord(file) || !hasExactKeys(file, ['relativePath', 'mimeType', 'byteLength', 'sourcePath', 'taskId', 'parseState', 'indexState'])
      || !relativePath(file.relativePath) || !isNonEmptyBoundedText(file.mimeType, 200)
      || !isSafeNonNegativeInteger(file.byteLength) || !relativePath(file.sourcePath)
      || !(file.taskId === null || isNonEmptyBoundedText(file.taskId))
      || !processingState(file.parseState) || !processingState(file.indexState)) throw invalidResult();
    return {
      relativePath: file.relativePath, mimeType: file.mimeType, byteLength: file.byteLength,
      sourcePath: file.sourcePath, taskId: file.taskId, parseState: file.parseState, indexState: file.indexState,
    };
  });
  return {
    archiveId: body.archiveId, projectId: input.projectId, requestKey: input.requestKey,
    title: body.title, sourceUrl: body.sourceUrl, callId: body.callId, accepted: true, saveState: 'saved', files,
  };
}

function responseError(operation: Operation, response: Response): AppServiceError {
  switch (response.status) {
    case 400: return new AppServiceError('invalid-request', 'Knowledge request is invalid.');
    case 401:
    case 403: return new AppServiceError('permission-denied', 'Knowledge request was denied.');
    case 404: return new AppServiceError('not-found', 'Knowledge project, file or archive was not found.');
    case 409: return new AppServiceError('conflict', 'Knowledge request conflicts with existing state.');
    case 413: return new AppServiceError('response-too-large', 'Knowledge payload exceeds the size limit.');
    default: return operation === 'archive' ? unknownArchive() : new AppServiceError('unavailable', 'Knowledge operation is unavailable.');
  }
}

export { read as decodeAppKnowledgeRead, search as decodeAppKnowledgeSearch };

export function createAppPluginKnowledge(pluginId: string, getTransports: () => Promise<RuntimeHostTransports>): AppKnowledgeApi {
  try { requirePluginId(pluginId); } catch { throw new AppServiceError('invalid-request', 'Knowledge plugin identifier is invalid.'); }

  async function execute<T>(operation: Operation, input: AppKnowledgeInputs[Operation], decode: (body: unknown) => T, signal?: AbortSignal): Promise<T> {
    cancelled(signal);
    if (!isAppServiceRequest({ service: 'knowledge', operation, input })) {
      throw new AppServiceError('invalid-request', 'Knowledge request is invalid; an explicit project ID and relative paths are required.');
    }
    const payload = operation === 'archive' || operation === 'archiveStatus' ? { ...input, pluginId }
      : operation === 'read' ? { ...input, limit: 0 } : input;
    const request: unknown = JSON.parse(boundedJson(payload, true));
    let transports: RuntimeHostTransports;
    try { transports = await getTransports(); } catch {
      cancelled(signal);
      throw new AppServiceError('unavailable', 'Knowledge runtime is unavailable.');
    }
    cancelled(signal);
    let response: Response;
    try {
      const wiki = transports.wikiTransport;
      switch (operation) {
        case 'list': response = await wiki.projects(); break;
        case 'listDir': {
          const directory = request as AppKnowledgeInputs['listDir'];
          response = await wiki.files(directory.projectId, directory.relativePath);
          break;
        }
        case 'read': response = await wiki.readFile(request); break;
        case 'search': response = await wiki.search(request); break;
        case 'retrieveContext': response = await wiki.retrieveContext(request); break;
        case 'archive': response = await wiki.archive(request, signal); break;
        case 'archiveStatus': response = await wiki.artifactStatus(request, signal); break;
      }
    } catch {
      if (operation === 'archive') throw unknownArchive();
      cancelled(signal);
      throw new AppServiceError('unavailable', 'Knowledge operation is unavailable.');
    }
    if (operation === 'archive' && signal?.aborted) throw unknownArchive();
    cancelled(signal);
    if (response.status !== (operation === 'archive' ? 202 : 200)) throw responseError(operation, response);
    try {
      boundedJson(response.body);
      const result = decode(response.body);
      boundedJson(result);
      return result;
    } catch (error) {
      if (operation === 'archive') throw unknownArchive();
      throw error;
    }
  }

  return {
    list: (input, signal) => execute('list', input, projects, signal),
    listDir: (input, signal) => execute('listDir', input, body => listDir(body, input), signal),
    read: (input, signal) => execute('read', input, body => read(body, input), signal),
    search: (input, signal) => execute('search', input, body => search(body, input), signal),
    retrieveContext: (input, signal) => execute('retrieveContext', input, body => search(body, input), signal),
    archive: (input, signal) => execute('archive', input, body => archive(body, input), signal),
    archiveStatus: (input, signal) => execute('archiveStatus', input, body => archive(body, input), signal),
  };
}
