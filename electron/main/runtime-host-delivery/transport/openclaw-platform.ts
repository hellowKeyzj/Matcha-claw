import type { RuntimeHostDeliveryIssuer } from '../issuer';
import { sendLoopbackJson } from './client';

const READ_SCOPE = 'openclaw.platform:read';
const WRITE_SCOPE = 'openclaw.platform:write';

const STATUS_ENDPOINT = '/api/openclaw/status';
const RUNTIME_PATHS_ENDPOINT = '/api/openclaw/runtime/paths';
const CLI_COMMAND_ENDPOINT = '/api/openclaw/cli-command';
const TOOL_PERMISSION_ENDPOINT = '/api/openclaw/tool-permission-mode';
const SUBAGENT_TEMPLATES_ENDPOINT = '/api/openclaw/subagent-templates';
const SUBAGENT_TEMPLATE_DETAIL_ENDPOINT = '/api/openclaw/subagent-template/detail';

const INVALID = { success: false, error: 'OpenClaw platform request is invalid' } as const;
const UNAVAILABLE = { success: false, error: 'OpenClaw platform is unavailable' } as const;

export type OpenClawPlatformResponse = Readonly<{
  status: 200 | 400 | 500 | 503;
  body: unknown;
}>;

export interface OpenClawPlatformTransport {
  environmentStatus(): Promise<OpenClawPlatformResponse>;
  runtimePaths(): Promise<OpenClawPlatformResponse>;
  cliCommand(): Promise<OpenClawPlatformResponse>;
  toolPermissionMode(): Promise<OpenClawPlatformResponse>;
  setToolPermissionMode(request: unknown): Promise<OpenClawPlatformResponse>;
  subagentTemplateCatalog(): Promise<OpenClawPlatformResponse>;
  subagentTemplateDetail(request: unknown): Promise<OpenClawPlatformResponse>;
}

export function createOpenClawPlatformTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): OpenClawPlatformTransport {
  const send = async (
    method: 'GET' | 'POST',
    path: string,
    scope: typeof READ_SCOPE | typeof WRITE_SCOPE,
    capability: string,
    subject: string,
    body?: unknown,
  ): Promise<OpenClawPlatformResponse> => {
    const response = await sendLoopbackJson({
      port: runtimeHostTransportPort,
      path,
      issuer,
      decision: { endpoint: path, scope, capability, subject },
      method,
      fetcher,
      ...(body === undefined ? { emptyContentLength: true } : { body }),
    });
    if (response?.status === 200) return { status: 200, body: response.body };
    if (response?.status === 400) return { status: 400, body: INVALID };
    if (response?.status === 500) return { status: 500, body: UNAVAILABLE };
    return { status: 503, body: UNAVAILABLE };
  };

  return {
    environmentStatus: () => send('GET', STATUS_ENDPOINT, READ_SCOPE, 'openclaw.environment.status', 'openclaw-environment-status'),
    runtimePaths: () => send('GET', RUNTIME_PATHS_ENDPOINT, READ_SCOPE, 'openclaw.runtime.paths', 'openclaw-runtime-paths'),
    cliCommand: () => send('GET', CLI_COMMAND_ENDPOINT, READ_SCOPE, 'openclaw.cli.command', 'openclaw-cli-command'),
    toolPermissionMode: () => send('GET', TOOL_PERMISSION_ENDPOINT, READ_SCOPE, 'openclaw.tool-permission.get', 'openclaw-tool-permission'),
    setToolPermissionMode: (request) => send('POST', TOOL_PERMISSION_ENDPOINT, WRITE_SCOPE, 'openclaw.tool-permission.set', 'openclaw-tool-permission', request),
    subagentTemplateCatalog: () => send('GET', SUBAGENT_TEMPLATES_ENDPOINT, READ_SCOPE, 'openclaw.subagent-templates.list', 'openclaw-subagent-templates'),
    subagentTemplateDetail: (request) => send('POST', SUBAGENT_TEMPLATE_DETAIL_ENDPOINT, READ_SCOPE, 'openclaw.subagent-templates.get', 'openclaw-subagent-template', request),
  };
}
