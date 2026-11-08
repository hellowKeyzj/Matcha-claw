import { join } from 'node:path';
import {
  APP_EXECUTION_OPERATIONS, APP_SERVICE_MAX_BYTES, APP_SERVICE_OPERATIONS, APP_SERVICE_VERSION,
  AppServiceError, isAppServiceRequest,
  type AppCapabilitiesInputs, type AppCapabilitiesResults, type AppServiceRequest, type AppServiceResult,
} from '../../../sdk/app-plugins/src/api';
import type { RuntimeHostTransports } from '../runtime-host-delivery/transport/host-api-transports';
import { createAppPluginCredentials, AppPluginCredentialError } from './credentials';
import { createAppPluginKnowledge } from './knowledge';
import { createAppPluginWorkspace } from './workspace';

type CapabilityOperation = AppCapabilitiesResults['describe']['operations'][number];
const WORKSPACE_OPERATIONS = {
  readText: 'files.readText', readBinary: 'files.readBinary', stat: 'files.stat',
  listDir: 'files.listDir', writeText: 'files.writeText', writeBinary: 'files.writeBinary',
} as const;
const KNOWLEDGE_OPERATIONS = {
  list: 'wiki.projects', listDir: 'wiki.files', read: 'wiki.readFile', search: 'wiki.search', retrieveContext: 'wiki.retrieveContext',
  archive: 'wiki.artifacts.archive', archiveStatus: 'wiki.artifacts.status',
} as const;

export function createAppPluginServices(options: { rootDir: string; getTransports(): Promise<RuntimeHostTransports> }) {
  const credentials = createAppPluginCredentials(join(options.rootDir, 'credentials'));
  const workspace = createAppPluginWorkspace(options.getTransports);
  async function describe(input: AppCapabilitiesInputs['describe'], signal: AbortSignal): Promise<AppCapabilitiesResults['describe']> {
    const transports = await options.getTransports();
    signal.throwIfAborted();
    const [secure, wiki, files, session, team] = await Promise.all([
      credentials.availability(),
      transports.capabilityDirectoryTransport.describe({ id: 'wiki', scope: { kind: 'app' } }),
      input.target ? transports.capabilityDirectoryTransport.describe({ id: 'workspace.file', scope: { kind: 'agent', ...input.target } }) : undefined,
      input.target ? transports.capabilityDirectoryTransport.describe({ id: 'session.prompt', scope: { kind: 'agent', ...input.target } }) : undefined,
      input.target ? transports.capabilityDirectoryTransport.describe({ id: 'team.runtime', scope: { kind: 'runtime-instance', endpoint: input.target.endpoint } }) : undefined,
    ]);
    signal.throwIfAborted();
    const operations: CapabilityOperation[] = [];
    const limits = { requestBytes: APP_SERVICE_MAX_BYTES, responseBytes: APP_SERVICE_MAX_BYTES };
    for (const operation of APP_SERVICE_OPERATIONS.workspace) {
      const supported = files?.status === 200 && 'capability' in files.body && files.body.capability.availability === 'available'
        && files.body.capability.operations.some(item => item.id === WORKSPACE_OPERATIONS[operation]);
      operations.push({ id: `workspace.${operation}`, status: !input.target ? 'request-dependent' : supported ? 'available' : 'unavailable',
        ...(!input.target ? { reason: 'target-required' } : supported ? {} : { reason: 'runtime-capability-unavailable' }),
        limits: { ...limits, contentBytes: operation === 'readText' || operation === 'writeText' ? 2 * 1024 * 1024 : 4 * 1024 * 1024 } });
    }
    for (const operation of APP_SERVICE_OPERATIONS.knowledge) {
      const supported = wiki.status === 200 && 'capability' in wiki.body && wiki.body.capability.availability === 'available'
        && wiki.body.capability.operations.some(item => item.id === KNOWLEDGE_OPERATIONS[operation]);
      operations.push({ id: `knowledge.${operation}`, status: supported ? 'available' : 'unavailable',
        ...(supported ? {} : { reason: 'wiki-capability-unavailable' }), limits: { ...limits, archiveContentBytes: 6 * 1024 * 1024 } });
    }
    for (const operation of APP_SERVICE_OPERATIONS.credentials) operations.push({
      id: `credentials.${operation}`, status: operation === 'availability' || secure.available ? 'available' : 'unavailable',
      ...(!secure.available && operation !== 'availability' ? { reason: secure.reason } : {}), limits: { valueBytes: 64 * 1024, entries: 128, payloadBytes: 512 * 1024 },
    });
    for (const operation of APP_EXECUTION_OPERATIONS) {
      const native = operation.includes('Team') ? team : session;
      const available = native?.status === 200 && 'capability' in native.body && native.body.capability.availability === 'available';
      const unavailable = !!input.target && !operation.startsWith('list') && !available;
      operations.push({ id: `execution.${operation}`, status: unavailable ? 'unavailable' : 'request-dependent',
        reason: unavailable ? 'runtime-capability-unavailable' : 'native-target-and-run-dependent',
        limits: { requestBytes: 1024 * 1024, responseBytes: 1024 * 1024 } });
    }
    for (const operation of ['list', 'generate', 'generateText', 'generateSpeech', 'transcribe', 'generateMusic', 'submitVideo', 'queryVideo', 'collectVideo']) operations.push({
      id: `models.${operation}`, status: 'request-dependent', reason: 'model-selection-and-provider-dependent', limits: {},
    });
    operations.push({ id: 'capabilities.describe', status: 'available', limits });
    return { sdkVersion: APP_SERVICE_VERSION, operations };
  }
  return {
    async service(pluginId: string, request: AppServiceRequest, signal: AbortSignal): Promise<AppServiceResult> {
      if (!isAppServiceRequest(request) || Buffer.byteLength(JSON.stringify(request)) > APP_SERVICE_MAX_BYTES) {
        throw new AppServiceError('invalid-request', 'Invalid app plugin service request.');
      }
      signal.throwIfAborted();
      let result: AppServiceResult;
      switch (request.service) {
        case 'workspace':
          switch (request.operation) {
            case 'readText': result = await workspace.readText(request.input, signal); break;
            case 'readBinary': result = await workspace.readBinary(request.input, signal); break;
            case 'stat': result = await workspace.stat(request.input, signal); break;
            case 'listDir': result = await workspace.listDir(request.input, signal); break;
            case 'writeText': result = await workspace.writeText(request.input, signal); break;
            case 'writeBinary': result = await workspace.writeBinary(request.input, signal); break;
          }
          break;
        case 'knowledge': {
          const knowledge = createAppPluginKnowledge(pluginId, options.getTransports);
          switch (request.operation) {
            case 'list': result = await knowledge.list(request.input, signal); break;
            case 'listDir': result = await knowledge.listDir(request.input, signal); break;
            case 'read': result = await knowledge.read(request.input, signal); break;
            case 'search': result = await knowledge.search(request.input, signal); break;
            case 'retrieveContext': result = await knowledge.retrieveContext(request.input, signal); break;
            case 'archive': result = await knowledge.archive(request.input, signal); break;
            case 'archiveStatus': result = await knowledge.archiveStatus(request.input, signal); break;
          }
          break;
        }
        case 'credentials': {
          const store = credentials.forPlugin(pluginId);
          try {
            switch (request.operation) {
              case 'availability': result = await store.availability(); break;
              case 'get': result = { value: await store.get(request.input.key) }; break;
              case 'set': await store.set(request.input.key, request.input.value); result = { stored: true }; break;
              case 'delete': await store.delete(request.input.key); result = { deleted: true }; break;
            }
          } catch (error) {
            if (error instanceof AppPluginCredentialError) throw new AppServiceError(error.code === 'invalid-request' ? 'invalid-request' : 'storage-unavailable', error.message);
            throw new AppServiceError('storage-unavailable', 'App plugin credential storage is unavailable.');
          }
          break;
        }
        case 'capabilities': result = await describe(request.input, signal); break;
      }
      if (Buffer.byteLength(JSON.stringify(result)) > APP_SERVICE_MAX_BYTES) throw new AppServiceError('response-too-large', 'App plugin service result exceeds the response limit.');
      return result;
    },
  };
}
