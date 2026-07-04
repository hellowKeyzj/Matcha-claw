import { validateCapabilityTarget, validateRuntimeScope, type CapabilityTarget, type RuntimeScope } from '../agent-runtime/contracts/runtime-address';
import { formatRuntimeHostDispatchError, invokeRuntimeCapability, parseRuntimeHostTimeoutMs, resolveRuntimeHostBaseUrl, resolveRuntimeHostTimeoutMs, RuntimeHostDispatchClientError } from './runtime-host-dispatch-client';

export interface MatchaRuntimeCommandIo {
  readonly stdout?: MatchaRuntimeCommandWriter;
  readonly stderr?: MatchaRuntimeCommandWriter;
  readonly fetchImpl?: typeof fetch;
}

export type MatchaRuntimeCommandWriter = {
  readonly write: (chunk: string) => unknown;
};

export type MatchaRuntimeCommandResult =
  | {
      readonly resultType: 'helpDisplayed';
      readonly exitCode: 0;
    }
  | {
      readonly resultType: 'runtimeInvoked';
      readonly exitCode: 0;
      readonly command: RuntimeInvokeCommand;
      readonly data: unknown;
    }
  | {
      readonly resultType: 'runtimeInvokeFailed';
      readonly exitCode: 1;
      readonly command: RuntimeInvokeCommand;
      readonly message: string;
    }
  | {
      readonly resultType: 'invalidCommand';
      readonly exitCode: 2;
      readonly message: string;
    };

export interface RuntimeInvokeCommand {
  readonly commandType: 'runtimeInvoke';
  readonly id: string;
  readonly operationId: string;
  readonly scope: RuntimeScope;
  readonly target: CapabilityTarget | null;
  readonly input: unknown;
  readonly runtimeHostBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly outputFormat: 'json' | 'text';
}

export type MatchaRuntimeCommandParseResult =
  | {
      readonly resultType: 'parsedRuntimeInvoke';
      readonly command: RuntimeInvokeCommand;
    }
  | {
      readonly resultType: 'helpRequested';
    }
  | {
      readonly resultType: 'invalidCommand';
      readonly message: string;
    };

type RuntimeInvokeOptionName = 'id' | 'operation' | 'scope' | 'target' | 'input' | 'runtime-host-url' | 'timeout-ms';

type RuntimeInvokeOptionValues = {
  readonly id?: string;
  readonly operation?: string;
  readonly scope?: string;
  readonly target?: string;
  readonly input?: string;
  readonly 'runtime-host-url'?: string;
  readonly 'timeout-ms'?: string;
  readonly json?: boolean;
};

const RUNTIME_INVOKE_USAGE = [
  'Usage:',
  '  matcha runtime invoke --id <capability> --scope <json> --operation <id> --target <json|null> --input <json> [--runtime-host-url <url>] [--timeout-ms <ms>] [--json]',
  '',
  'Arguments:',
  '  --id <capability>        Runtime host capability id, for example team.runtime',
  '  --scope <json>           RuntimeScope JSON object',
  '  --operation <id>         Runtime host operation id, for example team.nodeEvent',
  '  --target <json|null>     CapabilityTarget JSON object or null',
  '  --input <json>           JSON value passed as operation input',
  '  --runtime-host-url <url> Runtime host base URL. Defaults to MATCHACLAW_RUNTIME_HOST_BASE_URL or localhost.',
  '  --timeout-ms <ms>        Runtime host dispatch timeout. Defaults to 15000.',
  '  --json                   Emit machine-readable success/error envelopes on stdout.',
].join('\n');

export function parseMatchaRuntimeCommand(argv: readonly string[]): MatchaRuntimeCommandParseResult {
  if (argv.length === 0 || hasHelpFlag(argv)) {
    return { resultType: 'helpRequested' };
  }

  const commandTokens = stripOptionalExecutablePrefix(argv);
  if (commandTokens.length === 0 || hasHelpFlag(commandTokens)) {
    return { resultType: 'helpRequested' };
  }

  if (commandTokens[0] !== 'runtime' || commandTokens[1] !== 'invoke') {
    return {
      resultType: 'invalidCommand',
      message: 'Unknown command. Use: matcha runtime invoke --id <capability> --scope <json> --operation <id> --target <json|null> --input <json>',
    };
  }

  return parseRuntimeInvokeOptions(commandTokens.slice(2));
}

export function formatMatchaRuntimeCommandHelp(): string {
  return `${RUNTIME_INVOKE_USAGE}\n`;
}

export async function runMatchaRuntimeCommand(
  argv: readonly string[],
  io: MatchaRuntimeCommandIo = {},
): Promise<MatchaRuntimeCommandResult> {
  const parsedCommand = parseMatchaRuntimeCommand(argv);

  switch (parsedCommand.resultType) {
    case 'helpRequested':
      writeToCommandOutput(io.stdout, formatMatchaRuntimeCommandHelp());
      return { resultType: 'helpDisplayed', exitCode: 0 };
    case 'invalidCommand':
      writeInvalidCommand(parsedCommand.message, shouldEmitJsonForInvalidCommand(argv), io);
      return { resultType: 'invalidCommand', exitCode: 2, message: parsedCommand.message };
    case 'parsedRuntimeInvoke':
      return await invokeParsedRuntimeCommand(parsedCommand.command, io);
  }
}

async function invokeParsedRuntimeCommand(
  command: RuntimeInvokeCommand,
  io: MatchaRuntimeCommandIo,
): Promise<MatchaRuntimeCommandResult> {
  try {
    const data = await invokeRuntimeCapability({
      runtimeHostBaseUrl: command.runtimeHostBaseUrl,
      timeoutMs: command.timeoutMs,
      fetchImpl: io.fetchImpl,
      id: command.id,
      operationId: command.operationId,
      scope: command.scope,
      target: command.target,
      capabilityInput: command.input,
    });
    writeRuntimeInvokeSuccess(command, data, io);
    return { resultType: 'runtimeInvoked', exitCode: 0, command, data };
  } catch (error) {
    const message = formatRuntimeHostDispatchError(error);
    writeRuntimeInvokeFailure(command, error, message, io);
    return { resultType: 'runtimeInvokeFailed', exitCode: 1, command, message };
  }
}

function parseRuntimeInvokeOptions(tokens: readonly string[]): MatchaRuntimeCommandParseResult {
  const optionValues: Partial<Record<RuntimeInvokeOptionName, string>> & { json?: boolean } = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--json') {
      if (optionValues.json) {
        return {
          resultType: 'invalidCommand',
          message: 'Duplicate runtime invoke argument "--json". Provide each option once.',
        };
      }
      optionValues.json = true;
      continue;
    }

    if (!isRuntimeInvokeOptionToken(token)) {
      return {
        resultType: 'invalidCommand',
        message: `Unknown runtime invoke argument "${token}". Use --id <capability> --scope <json> --operation <id> --target <json|null> --input <json>.`,
      };
    }

    const optionName = token.slice(2) as RuntimeInvokeOptionName;
    if (optionValues[optionName] !== undefined) {
      return {
        resultType: 'invalidCommand',
        message: `Duplicate runtime invoke argument "${token}". Provide each option once.`,
      };
    }

    const optionValue = tokens[index + 1];
    if (optionValue === undefined || optionValue.startsWith('--')) {
      return {
        resultType: 'invalidCommand',
        message: `Missing value for runtime invoke argument "${token}".`,
      };
    }

    optionValues[optionName] = optionValue;
    index += 1;
  }

  return buildRuntimeInvokeCommand(optionValues);
}

function buildRuntimeInvokeCommand(optionValues: RuntimeInvokeOptionValues): MatchaRuntimeCommandParseResult {
  const id = optionValues.id?.trim();
  if (!id) {
    return {
      resultType: 'invalidCommand',
      message: 'Missing required runtime invoke argument "--id <capability>".',
    };
  }

  const operationId = optionValues.operation?.trim();
  if (!operationId) {
    return {
      resultType: 'invalidCommand',
      message: 'Missing required runtime invoke argument "--operation <id>".',
    };
  }

  if (optionValues.scope === undefined) {
    return {
      resultType: 'invalidCommand',
      message: 'Missing required runtime invoke argument "--scope <json>".',
    };
  }

  if (optionValues.target === undefined) {
    return {
      resultType: 'invalidCommand',
      message: 'Missing required runtime invoke argument "--target <json|null>".',
    };
  }

  if (optionValues.input === undefined) {
    return {
      resultType: 'invalidCommand',
      message: 'Missing required runtime invoke argument "--input <json>".',
    };
  }

  const parsedScope = parseRuntimeInvokeScope(optionValues.scope);
  if (parsedScope.resultType !== 'validScope') {
    return { resultType: 'invalidCommand', message: parsedScope.message };
  }

  const parsedTarget = parseRuntimeInvokeTarget(optionValues.target);
  if (parsedTarget.resultType !== 'validTarget') {
    return { resultType: 'invalidCommand', message: parsedTarget.message };
  }

  const parsedInput = parseJsonArgument(optionValues.input, 'input');
  if (parsedInput.resultType !== 'validJson') {
    return { resultType: 'invalidCommand', message: parsedInput.message };
  }

  const parsedTimeoutMs = optionValues['timeout-ms'] === undefined ? undefined : parseRuntimeHostTimeoutMs(optionValues['timeout-ms']);
  if (parsedTimeoutMs === null) {
    return { resultType: 'invalidCommand', message: `Invalid --timeout-ms value "${optionValues['timeout-ms']}".` };
  }

  return {
    resultType: 'parsedRuntimeInvoke',
    command: {
      commandType: 'runtimeInvoke',
      id,
      operationId,
      scope: parsedScope.scope,
      target: parsedTarget.target,
      input: parsedInput.value,
      runtimeHostBaseUrl: optionValues['runtime-host-url'] ? resolveRuntimeHostBaseUrl(optionValues['runtime-host-url']) : undefined,
      timeoutMs: parsedTimeoutMs === undefined ? undefined : resolveRuntimeHostTimeoutMs(parsedTimeoutMs),
      outputFormat: optionValues.json ? 'json' : 'text',
    },
  };
}

type RuntimeInvokeScopeParseResult =
  | {
      readonly resultType: 'validScope';
      readonly scope: RuntimeScope;
    }
  | {
      readonly resultType: 'invalidScope';
      readonly message: string;
    };

type RuntimeInvokeTargetParseResult =
  | {
      readonly resultType: 'validTarget';
      readonly target: CapabilityTarget | null;
    }
  | {
      readonly resultType: 'invalidTarget';
      readonly message: string;
    };

type JsonArgumentParseResult =
  | {
      readonly resultType: 'validJson';
      readonly value: unknown;
    }
  | {
      readonly resultType: 'invalidJson';
      readonly message: string;
    };

function parseRuntimeInvokeScope(rawScope: string): RuntimeInvokeScopeParseResult {
  const parsedScope = parseJsonArgument(rawScope, 'scope');
  if (parsedScope.resultType !== 'validJson') {
    return { resultType: 'invalidScope', message: parsedScope.message };
  }
  if (!isJsonObject(parsedScope.value)) {
    return {
      resultType: 'invalidScope',
      message: 'Invalid --scope JSON: expected a RuntimeScope object.',
    };
  }
  const scopeError = validateRuntimeScope(parsedScope.value);
  if (scopeError) {
    return {
      resultType: 'invalidScope',
      message: `Invalid --scope JSON: ${scopeError}.`,
    };
  }
  return { resultType: 'validScope', scope: parsedScope.value as RuntimeScope };
}

function parseRuntimeInvokeTarget(rawTarget: string): RuntimeInvokeTargetParseResult {
  const parsedTarget = parseJsonArgument(rawTarget, 'target');
  if (parsedTarget.resultType !== 'validJson') {
    return { resultType: 'invalidTarget', message: parsedTarget.message };
  }

  if (parsedTarget.value === null) {
    return { resultType: 'validTarget', target: null };
  }

  if (!isJsonObject(parsedTarget.value)) {
    return {
      resultType: 'invalidTarget',
      message: 'Invalid --target JSON: expected a CapabilityTarget object or null.',
    };
  }

  const targetError = validateCapabilityTarget(parsedTarget.value);
  if (targetError) {
    return {
      resultType: 'invalidTarget',
      message: `Invalid --target JSON: ${targetError}.`,
    };
  }

  return { resultType: 'validTarget', target: parsedTarget.value as CapabilityTarget };
}

function parseJsonArgument(rawJson: string, argumentName: 'scope' | 'target' | 'input'): JsonArgumentParseResult {
  try {
    return { resultType: 'validJson', value: JSON.parse(rawJson) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        resultType: 'invalidJson',
        message: `Invalid --${argumentName} JSON: ${error.message}.`,
      };
    }

    throw error;
  }
}

function stripOptionalExecutablePrefix(argv: readonly string[]): readonly string[] {
  if (argv[0] === 'matcha') {
    return argv.slice(1);
  }

  return argv;
}

function hasHelpFlag(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

function shouldEmitJsonForInvalidCommand(argv: readonly string[]): boolean {
  return argv.includes('--json');
}

function isRuntimeInvokeOptionToken(token: string): token is `--${RuntimeInvokeOptionName}` {
  return token === '--id'
    || token === '--operation'
    || token === '--scope'
    || token === '--target'
    || token === '--input'
    || token === '--runtime-host-url'
    || token === '--timeout-ms';
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function writeInvalidCommand(message: string, emitJson: boolean, io: MatchaRuntimeCommandIo): void {
  if (emitJson) {
    writeJsonLine(io.stdout, { success: false, error: { kind: 'invalidCommand', message } });
    return;
  }
  writeToCommandOutput(io.stderr, `${message}\n`);
}

function writeRuntimeInvokeSuccess(command: RuntimeInvokeCommand, data: unknown, io: MatchaRuntimeCommandIo): void {
  writeJsonLine(io.stdout, command.outputFormat === 'json' ? { success: true, data } : data);
}

function writeRuntimeInvokeFailure(command: RuntimeInvokeCommand, error: unknown, message: string, io: MatchaRuntimeCommandIo): void {
  if (command.outputFormat === 'json') {
    writeJsonLine(io.stdout, { success: false, error: buildRuntimeInvokeErrorPayload(error, message) });
    return;
  }
  writeToCommandOutput(io.stderr, `${message}\n`);
}

function buildRuntimeInvokeErrorPayload(error: unknown, message: string): Record<string, unknown> {
  if (error instanceof RuntimeHostDispatchClientError) {
    return {
      kind: error.kind,
      message: error.message,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.code ? { code: error.code } : {}),
    };
  }
  return { kind: 'unknown', message };
}

function writeJsonLine(writer: MatchaRuntimeCommandWriter | undefined, value: unknown): void {
  writeToCommandOutput(writer, `${JSON.stringify(value)}\n`);
}

function writeToCommandOutput(writer: MatchaRuntimeCommandWriter | undefined, message: string): void {
  writer?.write(message);
}
