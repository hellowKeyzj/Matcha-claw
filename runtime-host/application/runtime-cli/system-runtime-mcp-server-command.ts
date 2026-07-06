import type { Readable, Writable } from 'node:stream';
import { validateRuntimeEndpointRef, type RuntimeEndpointRef } from '../agent-runtime/contracts/runtime-address';
import { formatRuntimeHostDispatchError, invokeRuntimeCapability, parseRuntimeHostTimeoutMs, resolveRuntimeHostBaseUrl, resolveRuntimeHostTimeoutMs } from './runtime-host-dispatch-client';
import { jsonRpcError, jsonRpcResult, runJsonRpcStdioServer, type JsonRpcRequest } from './mcp-stdio-json-rpc';

type SystemRuntimeMcpServerCommand =
  | {
      readonly commandType: 'stdio';
      readonly runtimeHostBaseUrl?: string;
      readonly timeoutMs?: number;
    }
  | {
      readonly commandType: 'usage';
      readonly reason: 'missingCommand' | 'unknownCommand' | 'missingOptionValue' | 'invalidTimeout';
      readonly receivedCommand: readonly string[];
      readonly detail?: string;
    };

export interface SystemRuntimeMcpServerCommandIo {
  readonly stdin?: Pick<Readable, 'on' | 'resume'>;
  readonly stdout?: Pick<Writable, 'write'>;
  readonly stderr?: Pick<Writable, 'write'>;
}

type SystemRuntimeMcpToolName = 'team_node_event' | 'team_graph_patch' | 'team_graph_context';

const SYSTEM_RUNTIME_MCP_USAGE = 'Usage: matcha system-runtime mcp-stdio [--runtime-host-url <url>] [--timeout-ms <ms>]';
const SYSTEM_RUNTIME_MCP_SERVER_NAME = 'matcha';
const SYSTEM_RUNTIME_MCP_PROTOCOL_VERSION = '2024-11-05';

export async function runSystemRuntimeMcpServerCommand(
  argv: readonly string[],
  io: SystemRuntimeMcpServerCommandIo = {},
): Promise<number> {
  const streams = resolveSystemRuntimeMcpServerCommandIo(io);

  try {
    const command = parseSystemRuntimeMcpServerCommand(argv);

    switch (command.commandType) {
      case 'stdio':
        return await runSystemRuntimeMcpStdioServer(streams, command);
      case 'usage':
        writeLine(streams.stderr, formatUsageError(command));
        return 1;
    }
  } catch (error) {
    writeLine(streams.stderr, formatUnknownSystemRuntimeMcpError(error));
    return 1;
  }
}

function parseSystemRuntimeMcpServerCommand(argv: readonly string[]): SystemRuntimeMcpServerCommand {
  const command = stripSystemRuntimeMcpServerCommandPrefix(argv);

  if (command.length === 0) {
    return { commandType: 'usage', reason: 'missingCommand', receivedCommand: command };
  }
  if (command[0] !== 'mcp-stdio') {
    return { commandType: 'usage', reason: 'unknownCommand', receivedCommand: command };
  }

  return parseSystemRuntimeMcpStdioOptions(command.slice(1), command);
}

function parseSystemRuntimeMcpStdioOptions(tokens: readonly string[], receivedCommand: readonly string[]): SystemRuntimeMcpServerCommand {
  let runtimeHostBaseUrl: string | undefined;
  let timeoutMs: number | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token !== '--runtime-host-url' && token !== '--timeout-ms') {
      return { commandType: 'usage', reason: 'unknownCommand', receivedCommand };
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return { commandType: 'usage', reason: 'missingOptionValue', receivedCommand, detail: `Missing value for system runtime MCP option "${token}".` };
    }
    if (token === '--runtime-host-url') {
      runtimeHostBaseUrl = value;
    } else {
      const parsedTimeoutMs = parseRuntimeHostTimeoutMs(value);
      if (parsedTimeoutMs === null) {
        return { commandType: 'usage', reason: 'invalidTimeout', receivedCommand, detail: `Invalid --timeout-ms value "${value}".` };
      }
      timeoutMs = parsedTimeoutMs;
    }
    index += 1;
  }

  return { commandType: 'stdio', runtimeHostBaseUrl, timeoutMs };
}

function stripSystemRuntimeMcpServerCommandPrefix(argv: readonly string[]): readonly string[] {
  if (argv[0] === 'matcha' && argv[1] === 'system-runtime') {
    return argv.slice(2);
  }

  if (argv[0] === 'system-runtime') {
    return argv.slice(1);
  }

  return argv;
}

async function runSystemRuntimeMcpStdioServer(io: Required<SystemRuntimeMcpServerCommandIo>, command: Extract<SystemRuntimeMcpServerCommand, { commandType: 'stdio' }>): Promise<number> {
  await runJsonRpcStdioServer(io, createSystemRuntimeMcpHandler({
    runtimeHostBaseUrl: resolveRuntimeHostBaseUrl(command.runtimeHostBaseUrl),
    timeoutMs: resolveRuntimeHostTimeoutMs(command.timeoutMs),
  }));
  return 0;
}

function resolveSystemRuntimeMcpServerCommandIo(io: SystemRuntimeMcpServerCommandIo): Required<SystemRuntimeMcpServerCommandIo> {
  return {
    stdin: io.stdin ?? process.stdin,
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
  };
}

function createSystemRuntimeMcpHandler(runtimeHost: { readonly runtimeHostBaseUrl: string; readonly timeoutMs: number }): (request: JsonRpcRequest) => Promise<unknown> | unknown {
  return async (request) => {
    if (request.method === 'initialize') {
      return jsonRpcResult(request.id, {
        protocolVersion: SYSTEM_RUNTIME_MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: SYSTEM_RUNTIME_MCP_SERVER_NAME,
          version: '0.0.0',
        },
      });
    }

    if (request.method === 'notifications/initialized') {
      return undefined;
    }

    if (request.method === 'tools/list') {
      return jsonRpcResult(request.id, { tools: buildSystemRuntimeMcpTools() });
    }

    if (request.method === 'tools/call') {
      const params = readRecord(request.params);
      const toolName = readToolName(params.name);
      if (!toolName) {
        return jsonRpcError(request.id, -32602, 'tools/call requires a supported TeamRun tool name');
      }
      try {
        const result = await invokeTeamRuntimeTool(runtimeHost, toolName, readRecord(params.arguments));
        return jsonRpcResult(request.id, {
          content: [{ type: 'text', text: JSON.stringify(projectTeamRuntimeToolResultForMcp(toolName, result)) }],
        });
      } catch (error) {
        return jsonRpcResult(request.id, {
          isError: true,
          content: [{ type: 'text', text: formatRuntimeHostDispatchError(error) }],
        });
      }
    }

    return jsonRpcError(request.id, -32601, `Unsupported MCP method: ${request.method}`);
  };
}

function buildSystemRuntimeMcpTools(): unknown[] {
  return [
    {
      name: 'team_node_event',
      description: 'Report a fact about your current TeamRun node execution through runtime-host. Use it only for the nodeExecutionId from the current TeamRun node prompt or team_graph_context. Always include runId, flat runtime endpoint fields, nodeExecutionId, event, top-level summary, and a stable idempotencyKey. complete/reject are terminal for that nodeExecutionId: after success=true, stop calling this tool for the same nodeExecutionId. Retry the same event only with the same idempotencyKey after transport uncertainty. Do not invent the next attempt id; wait for a new TeamRun node prompt before reporting rework output.',
      inputSchema: {
        type: 'object',
        additionalProperties: true,
        allOf: [buildRuntimeEndpointInputRequirement()],
        properties: {
          runId: { type: 'string', description: 'TeamRun id that owns the node execution.' },
          teamId: { type: 'string', description: 'Optional team id when known; it narrows the TeamRun scope.' },
          ...buildRuntimeEndpointInputProperties(),
          nodeExecutionId: { type: 'string', description: 'The current node execution id from your prompt or team_graph_context.' },
          event: { type: 'string', enum: ['progress', 'request_input', 'request_approval', 'reject', 'complete'], description: 'Use progress for status updates, request_input for user input, request_approval before risky or gated action, reject for failed/blocked work, and complete only after the node output is actually ready.' },
          summary: { type: 'string', description: 'Required top-level concise factual summary for capability validation. Repeat result.summary here when they are the same.' },
          result: {
            type: 'object',
            description: 'Structured NodeResult committed by complete/reject and optionally carried to downstream attempts by edge payload.includeUpstreamResult.',
            properties: {
              kind: { type: 'string', enum: ['trigger', 'work', 'review', 'human_decision', 'script_check', 'joined', 'final'], description: 'Result category for the completed/rejected node: trigger, work, review, human decision, script check, join, or final output.' },
              summary: { type: 'string', description: 'Short factual summary of this node result. Also provide top-level summary for runtime-host capability validation.' },
              content: { type: 'string', description: 'Optional full node output or human-readable details. Keep large outputs in artifacts and reference them instead.' },
              decision: { type: 'string', enum: ['approved', 'rejected', 'aborted', 'passed', 'failed', 'completed', 'joined'], description: 'Optional structured decision for approval, review, script-check, join, or final nodes.' },
              assignments: {
                type: 'array',
                description: 'Optional role assignments from leader-like nodes. Each item must target a TeamRun roleId, not an OpenClaw agent id.',
                items: {
                  type: 'object',
                  properties: {
                    roleId: { type: 'string', description: 'TeamRun roleId from the TeamSkill role roster.' },
                    text: { type: 'string', description: 'Complete task instructions for that role.' },
                  },
                  required: ['roleId', 'text'],
                },
              },
              evidenceRefs: { type: 'array', description: 'Optional evidence references that support this NodeResult. Use objects with type workspacePath, uri, artifact, or inlineText; do not use kind:file.' },
              artifactIds: { type: 'array', description: 'Optional ids of artifacts produced by this node result.', items: { type: 'string' } },
              metadata: { type: 'object', description: 'Optional small structured details for downstream context or audit projection. Do not include secrets, tokens, or large outputs.' },
            },
            required: ['kind', 'summary'],
          },
          idempotencyKey: { type: 'string', description: 'Stable unique key for this exact node event; reuse it only when retrying the same event after transport uncertainty.' },
          roleId: { type: 'string', description: 'Optional role id; when provided it must match the node role.' },
          outputPort: { type: 'string', description: 'Optional graph output port for reject/complete events when the node has a specific branch.' },
          sourceAgentId: { type: 'string', description: 'Optional agent identity to persist with the command.' },
          evidenceRefs: { type: 'array', description: 'Optional evidence references that support the event. Use objects with type workspacePath, uri, artifact, or inlineText; do not use kind:file.' },
          requestedAction: { type: 'string', description: 'For request_approval, the concrete action you want approved.' },
          risk: { type: 'string', description: 'For request_approval, the main risk or consequence the user should evaluate.' },
          metadata: { type: 'object', description: 'Small structured details for runtime/audit projection; do not include secrets, tokens, or large outputs.' },
        },
        required: ['runId', 'runtimeKind', 'nodeExecutionId', 'event', 'summary', 'idempotencyKey'],
      },
    },
    {
      name: 'team_graph_patch',
      description: 'Submit an intentional TeamRun graph topology/config patch through runtime-host. Use only to add/replace/remove nodes or edges, or update graph/node config such as stable node.config.prompt. Do not use it to submit one-off node output; use team_node_event result for assignments/results. Edges use action plus payload.includeUpstreamResult to control activation and result propagation. If the call fails or returns isError, do not assume the graph changed.',
      inputSchema: {
        type: 'object',
        additionalProperties: true,
        allOf: [buildRuntimeEndpointInputRequirement()],
        properties: {
          runId: { type: 'string', description: 'TeamRun id whose graph should be patched.' },
          teamId: { type: 'string', description: 'Optional team id when known; it narrows the TeamRun scope.' },
          ...buildRuntimeEndpointInputProperties(),
          summary: { type: 'string', description: 'Why this graph change is necessary and what it changes.' },
          patch: {
            type: 'object',
            description: 'Graph patch to apply against the current TeamRun graph. Operations must be intentional and non-empty.',
            properties: {
              baseGraphId: { type: 'string', description: 'Optional graph id you based the patch on.' },
              baseWorkflowPlanId: { type: 'string', description: 'Optional workflow plan id you based the patch on.' },
              operations: { type: 'array', description: 'Non-empty list of operations: add_node, replace_node, remove_node, add_edge, replace_edge, remove_edge, or set_metadata.' },
            },
            required: ['operations'],
          },
          idempotencyKey: { type: 'string', description: 'Stable unique key for this exact graph patch; reuse it only when retrying the same patch after transport uncertainty.' },
          sourceAgentId: { type: 'string', description: 'Optional agent identity to persist with the command.' },
          metadata: { type: 'object', description: 'Small structured audit details for the graph patch; do not include secrets, tokens, or large outputs.' },
        },
        required: ['runId', 'runtimeKind', 'summary', 'patch', 'idempotencyKey'],
      },
    },
    {
      name: 'team_graph_context',
      description: 'Read compact TeamRun graph context through runtime-host before acting when you need the current topology, node identity, statuses, pending approvals, or recent events. Prefer this before team_node_event or team_graph_patch if the prompt does not already give a fresh runId/nodeExecutionId/graph view. Do not use it to fetch full graph config, hidden prompts, secrets, or large artifacts; it returns only compact execution context. After reading, use the returned node/topology facts to choose the next tool, and stop if the context shows you are on the wrong run or node.',
      inputSchema: {
        type: 'object',
        additionalProperties: true,
        allOf: [buildRuntimeEndpointInputRequirement()],
        properties: {
          runId: { type: 'string', description: 'TeamRun id whose compact graph context should be read.' },
          teamId: { type: 'string', description: 'Optional team id when known; it narrows the TeamRun scope.' },
          ...buildRuntimeEndpointInputProperties(),
          nodeExecutionId: { type: 'string', description: 'Optional current node execution id to focus the context on one node.' },
          view: { type: 'string', enum: ['current_node', 'graph_summary'], description: 'Use current_node for your assigned node and immediate neighbors; use graph_summary for a broader compact run overview.' },
        },
        required: ['runId', 'runtimeKind'],
      },
    },
  ];
}

function buildRuntimeEndpointInputProperties(): Record<string, unknown> {
  return {
    runtimeKind: {
      type: 'string',
      enum: ['native-runtime', 'protocol-connector'],
      description: 'Flat runtime endpoint kind. Use native-runtime with runtimeAdapterId/runtimeInstanceId, or protocol-connector with protocolId/connectorId/endpointId.',
    },
    runtimeAdapterId: { type: 'string', description: 'Required when runtimeKind is native-runtime.' },
    runtimeInstanceId: { type: 'string', description: 'Required when runtimeKind is native-runtime.' },
    protocolId: { type: 'string', description: 'Required when runtimeKind is protocol-connector.' },
    connectorId: { type: 'string', description: 'Required when runtimeKind is protocol-connector.' },
    endpointId: { type: 'string', description: 'Required when runtimeKind is protocol-connector.' },
  };
}

function buildRuntimeEndpointInputRequirement(): Record<string, unknown> {
  return {
    anyOf: [
      { required: ['runtimeKind', 'runtimeAdapterId', 'runtimeInstanceId'] },
      { required: ['runtimeKind', 'protocolId', 'connectorId', 'endpointId'] },
    ],
  };
}

function projectTeamRuntimeToolResultForMcp(toolName: SystemRuntimeMcpToolName, result: unknown): unknown {
  if (toolName === 'team_graph_context') return result;
  const record = readRecord(result);
  return {
    success: record.success,
    runId: record.runId,
    accepted: record.accepted,
  };
}

async function invokeTeamRuntimeTool(
  runtimeHost: { readonly runtimeHostBaseUrl: string; readonly timeoutMs: number },
  toolName: SystemRuntimeMcpToolName,
  input: Record<string, unknown>,
): Promise<unknown> {
  const runId = requireString(input, 'runId');
  const teamId = readString(input.teamId);
  const endpoint = readRuntimeEndpointFromFlatInput(input);
  return await invokeRuntimeCapability({
    runtimeHostBaseUrl: runtimeHost.runtimeHostBaseUrl,
    timeoutMs: runtimeHost.timeoutMs,
    id: 'team.runtime',
    operationId: operationIdForSystemRuntimeMcpTool(toolName),
    scope: {
      kind: 'team-run',
      endpoint,
      runId,
      ...(teamId ? { teamId } : {}),
    },
    target: {
      kind: 'team-run',
      runId,
      ...(teamId ? { teamId } : {}),
    },
    capabilityInput: input,
  });
}

function readRuntimeEndpointFromFlatInput(input: Record<string, unknown>): RuntimeEndpointRef {
  const runtimeKind = requireString(input, 'runtimeKind');
  const endpoint = runtimeKind === 'native-runtime'
    ? {
      kind: 'native-runtime' as const,
      runtimeAdapterId: requireString(input, 'runtimeAdapterId'),
      runtimeInstanceId: requireString(input, 'runtimeInstanceId'),
    }
    : runtimeKind === 'protocol-connector'
      ? {
        kind: 'protocol-connector' as const,
        protocolId: requireString(input, 'protocolId'),
        connectorId: requireString(input, 'connectorId'),
        endpointId: requireString(input, 'endpointId'),
      }
      : null;
  if (!endpoint) {
    throw new Error('runtimeKind must be native-runtime or protocol-connector');
  }
  const validationError = validateRuntimeEndpointRef(endpoint);
  if (validationError) {
    throw new Error(`flat runtime endpoint fields are invalid: ${validationError}`);
  }
  return endpoint;
}

function operationIdForSystemRuntimeMcpTool(toolName: SystemRuntimeMcpToolName): 'team.nodeEvent' | 'team.graphPatch' | 'team.graphContext' {
  switch (toolName) {
    case 'team_node_event':
      return 'team.nodeEvent';
    case 'team_graph_patch':
      return 'team.graphPatch';
    case 'team_graph_context':
      return 'team.graphContext';
  }
}

function readToolName(value: unknown): SystemRuntimeMcpToolName | null {
  return value === 'team_node_event' || value === 'team_graph_patch' || value === 'team_graph_context' ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requireString(input: Record<string, unknown>, field: string): string {
  const value = readString(input[field]);
  if (!value) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function formatUsageError(command: Extract<SystemRuntimeMcpServerCommand, { commandType: 'usage' }>): string {
  if (command.detail) {
    return `${command.detail} ${SYSTEM_RUNTIME_MCP_USAGE}`;
  }
  if (command.reason === 'missingCommand') {
    return `Missing system runtime MCP sub-command. ${SYSTEM_RUNTIME_MCP_USAGE}`;
  }

  return `Unknown system runtime MCP sub-command "${command.receivedCommand.join(' ')}". ${SYSTEM_RUNTIME_MCP_USAGE}`;
}

function formatUnknownSystemRuntimeMcpError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Unexpected system runtime MCP stdio server failure: ${detail}`;
}

function writeLine(stream: Pick<Writable, 'write'>, line: string): void {
  stream.write(`${line}\n`);
}
