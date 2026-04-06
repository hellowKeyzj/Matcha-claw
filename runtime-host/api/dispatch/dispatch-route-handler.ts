import { TRANSPORT_VERSION } from '../common/constants';
import { normalizeRoutePath, sendJson } from '../common/http';
import {
  buildExecutionSyncAction,
  isExecutionSyncRoute,
  syncExecutionStateFromPayload,
} from './execution-sync';
import { parseDispatchEnvelope } from './dispatch-envelope';
import type { LocalDispatchResponse } from './local-business-dispatch-types';
import type { ParentExecutionSyncAction, ParentTransportUpstreamPayload } from './parent-transport';

interface TransportStats {
  totalDispatchRequests: number;
  localBusinessHandled: number;
  executionSyncHandled: number;
  executionSyncFailed: number;
  unhandledRouteCount: number;
  badRequestRejected: number;
  dispatchInternalError: number;
}

interface DispatchRouteDeps {
  transportStats: TransportStats;
  tryHandleLocalBusinessDispatch: (
    method: string,
    route: string,
    payload: unknown,
  ) => Promise<LocalDispatchResponse | null>;
  requestParentExecutionSync: (
    action: ParentExecutionSyncAction,
    payload?: unknown,
  ) => Promise<ParentTransportUpstreamPayload>;
  buildLocalPluginsRuntimePayload: () => unknown;
  setPluginExecutionEnabled: (enabled: boolean) => void;
  setEnabledPluginIds: (pluginIds: string[]) => void;
}

function readRequestBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: unknown) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
    req.on('error', reject);
  });
}

export function handleDispatchRoute(req: any, res: any, deps: DispatchRouteDeps): void {
  readRequestBody(req).then(async (rawBody) => {
    try {
      const envelope = parseDispatchEnvelope(rawBody);
      deps.transportStats.totalDispatchRequests += 1;
      if (!envelope.ok) {
        deps.transportStats.badRequestRejected += 1;
        sendJson(res, envelope.status, {
          version: TRANSPORT_VERSION,
          success: false,
          status: envelope.status,
          error: envelope.error,
        });
        return;
      }
      const parsed = envelope.value;

      const localResponse = await deps.tryHandleLocalBusinessDispatch(parsed.method, parsed.route, parsed.payload);
      if (localResponse) {
        deps.transportStats.localBusinessHandled += 1;
        sendJson(res, localResponse.status, {
          version: TRANSPORT_VERSION,
          success: true,
          status: localResponse.status,
          data: localResponse.data,
        });
        return;
      }

      if (isExecutionSyncRoute(parsed.method, parsed.route)) {
        const action = buildExecutionSyncAction(parsed.method, parsed.route, parsed.payload);
        if (!action.ok) {
          deps.transportStats.badRequestRejected += 1;
          sendJson(res, action.status, {
            version: TRANSPORT_VERSION,
            success: false,
            status: action.status,
            error: action.error,
          });
          return;
        }

        deps.transportStats.executionSyncHandled += 1;
        const syncResponse = await deps.requestParentExecutionSync(action.action, action.payload);
        if (!syncResponse.success) {
          deps.transportStats.executionSyncFailed += 1;
          sendJson(res, syncResponse.status, {
            version: TRANSPORT_VERSION,
            success: false,
            status: syncResponse.status,
            error: syncResponse.error,
          });
          return;
        }

        syncExecutionStateFromPayload(syncResponse.data, {
          setPluginExecutionEnabled: deps.setPluginExecutionEnabled,
          setEnabledPluginIds: deps.setEnabledPluginIds,
        });
        sendJson(res, syncResponse.status, {
          version: TRANSPORT_VERSION,
          success: true,
          status: syncResponse.status,
          data: deps.buildLocalPluginsRuntimePayload(),
        });
        return;
      }

      deps.transportStats.unhandledRouteCount += 1;
      sendJson(res, 404, {
        version: TRANSPORT_VERSION,
        success: false,
        status: 404,
        error: {
          code: 'NOT_FOUND',
          message: `Runtime Host route not implemented: ${parsed.method} ${normalizeRoutePath(parsed.route)}`,
        },
      });
    } catch (error) {
      const isBadRequest = error instanceof SyntaxError;
      const statusCode = isBadRequest ? 400 : 500;
      if (isBadRequest) {
        deps.transportStats.badRequestRejected += 1;
      } else {
        deps.transportStats.dispatchInternalError += 1;
      }
      sendJson(res, statusCode, {
        version: TRANSPORT_VERSION,
        success: false,
        status: statusCode,
        error: {
          code: isBadRequest ? 'BAD_REQUEST' : 'INTERNAL_ERROR',
          message: `Dispatch failure: ${String(error)}`,
        },
      });
    }
  }).catch((error) => {
    deps.transportStats.dispatchInternalError += 1;
    sendJson(res, 500, {
      version: TRANSPORT_VERSION,
      success: false,
      status: 500,
      error: {
        code: 'INTERNAL_ERROR',
        message: `Dispatch failure: ${String(error)}`,
      },
    });
  });
}
