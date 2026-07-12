import type {
  RemoteFleetBootstrapCommandEnvelope,
  RemoteFleetBootstrapCommandResult,
  RemoteFleetBootstrapEnrollmentContext,
  RemoteFleetBootstrapFailureReason,
  RemoteFleetBootstrapProvider,
  RemoteFleetBootstrapProviderContext,
  RemoteFleetBootstrapSecretReadResult,
  RemoteFleetConnectionProbeEnvelope,
  RemoteFleetConnectionProbeFailureReason,
  RemoteFleetConnectionProbeProvider,
  RemoteFleetConnectionProbeResult,
} from './remote-fleet-bootstrap';
import {
  readRemoteFleetSshAuthSecretRef,
  readRemoteFleetSshConnectionConfig as readRemoteFleetSshConnectionConfigForConnection,
  readRemoteFleetSshTargetConfig as readRemoteFleetSshTargetConfigForNode,
  type RemoteFleetSshTargetConfig,
} from './remote-fleet-ssh-target-config';
import {
  createRemoteFleetSshClient,
  createRemoteFleetSshTerminalProvider,
  type RemoteFleetSshClient,
  type RemoteFleetSshClientConnectConfig,
  type RemoteFleetSshClientFactory,
  type RemoteFleetSshTerminalFailureReason,
} from './remote-fleet-terminal-ssh-provider';
import type { RemoteFleetTerminalSecretResolver } from './remote-fleet-terminal-providers';

const SSH_PROVIDER_KIND = 'ssh' as const;
const SSH_CONNECT_READY_TIMEOUT_MS = 15_000;
const SSH_INSTALL_TIMEOUT_MS = 120_000;
const SSH_MAX_BUFFER_BYTES = 64 * 1024;
const OUTPUT_SUMMARY_LIMIT = 1_000;

type SshAuthMaterial =
  | { readonly resultType: 'private-key'; readonly privateKey: string }
  | { readonly resultType: 'password'; readonly password: string };

type SshAuthMaterialReadResult = SshAuthMaterial
  | { readonly resultType: 'failed'; readonly result: RemoteFleetBootstrapCommandResult };

type SshConnectionProbeAuthReadResult = SshAuthMaterial
  | { readonly resultType: 'failed'; readonly result: RemoteFleetConnectionProbeResult };

interface SshExecOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
  readonly signal?: string;
}

type SshExecCommandResult =
  | { readonly resultType: 'completed'; readonly output: SshExecOutput }
  | { readonly resultType: 'failed'; readonly reason: RemoteFleetBootstrapFailureReason; readonly message: string };

export interface RemoteFleetSshBootstrapProviderDeps {
  readonly createSshClient?: RemoteFleetSshClientFactory;
}

export const REMOTE_FLEET_SSH_BOOTSTRAP_PROVIDER: RemoteFleetBootstrapProvider & RemoteFleetConnectionProbeProvider = createRemoteFleetSshBootstrapProvider();

export function createRemoteFleetSshBootstrapProvider(
  deps: RemoteFleetSshBootstrapProviderDeps = {},
): RemoteFleetBootstrapProvider & RemoteFleetConnectionProbeProvider {
  return {
    providerKind: SSH_PROVIDER_KIND,
    async dispatchCommand(
      envelope: RemoteFleetBootstrapCommandEnvelope,
      context: RemoteFleetBootstrapProviderContext,
    ): Promise<RemoteFleetBootstrapCommandResult> {
      if (envelope.providerKind !== SSH_PROVIDER_KIND || (envelope.node.targetKind !== 'ssh-host' && envelope.node.targetKind !== 'vm')) {
        return failedResult(envelope, 'unsupported-target', 'Remote Fleet SSH bootstrap provider only supports ssh-host and vm targets.');
      }

      switch (envelope.commandName) {
        case 'probe-node':
          return probeNode(envelope, context, deps);
        case 'delete-environment':
          return failedResult(envelope, 'unsupported-target', 'Remote Fleet SSH environment cleanup is not supported.');
        case 'install-agent':
        case 'deploy-environment': {
          if (envelope.commandName === 'deploy-environment' && !envelope.environment) {
            return failedResult(envelope, 'invalid-config', 'Remote Fleet SSH deploy-environment requires a Remote Fleet environment.');
          }
          const configRead = readRemoteFleetSshTargetConfig(envelope);
          if (configRead.resultType === 'failed') return configRead.result;
          return installAgent(envelope, context, configRead.config, deps);
        }
      }
    },
    async probeConnection(
      envelope: RemoteFleetConnectionProbeEnvelope,
      context: RemoteFleetBootstrapProviderContext,
    ): Promise<RemoteFleetConnectionProbeResult> {
      return await probeSshConnection(envelope, context, deps);
    },
  };
}

async function probeSshConnection(
  envelope: RemoteFleetConnectionProbeEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  deps: RemoteFleetSshBootstrapProviderDeps,
): Promise<RemoteFleetConnectionProbeResult> {
  if (envelope.providerKind !== SSH_PROVIDER_KIND
    || (envelope.connection.connectionKind !== 'ssh-host' && envelope.connection.connectionKind !== 'vm')) {
    return failedConnectionProbe(envelope, 'unsupported');
  }

  const configRead = readRemoteFleetSshConnectionConfig(envelope);
  if (configRead.resultType === 'failed') return configRead.result;

  const authRead = await readSshConnectionProbeAuthMaterial(envelope, context);
  if (authRead.resultType === 'failed') return authRead.result;

  return await connectSshConnectionProbe({
    envelope,
    config: configRead.config,
    auth: authRead,
    createSshClient: deps.createSshClient ?? createRemoteFleetSshClient,
  });
}

async function connectSshConnectionProbe(input: {
  readonly envelope: RemoteFleetConnectionProbeEnvelope;
  readonly config: RemoteFleetSshTargetConfig;
  readonly auth: SshAuthMaterial;
  readonly createSshClient: RemoteFleetSshClientFactory;
}): Promise<RemoteFleetConnectionProbeResult> {
  let client: RemoteFleetSshClient;
  try {
    client = await input.createSshClient();
  } catch {
    return failedConnectionProbe(input.envelope, 'unavailable');
  }

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: RemoteFleetConnectionProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.end();
      resolve(result);
    };
    const timeout = setTimeout(() => {
      finish(failedConnectionProbe(input.envelope, 'timeout'));
    }, SSH_CONNECT_READY_TIMEOUT_MS);

    client.on('ready', () => {
      finish({
        resultType: 'completed',
        commandId: input.envelope.commandId,
        providerKind: SSH_PROVIDER_KIND,
      });
    });
    client.on('error', (error) => {
      finish(failedConnectionProbe(input.envelope, classifySshConnectionProbeFailure(error)));
    });
    client.on('close', () => {
      finish(failedConnectionProbe(input.envelope, 'network'));
    });

    try {
      client.connect(buildSshConnectConfig(input.config, input.auth));
    } catch (error) {
      finish(failedConnectionProbe(input.envelope, classifySshConnectionProbeFailure(error)));
    }
  });
}

function readRemoteFleetSshConnectionConfig(
  envelope: RemoteFleetConnectionProbeEnvelope,
): { readonly resultType: 'valid'; readonly config: RemoteFleetSshTargetConfig } | { readonly resultType: 'failed'; readonly result: RemoteFleetConnectionProbeResult } {
  const targetKind = envelope.connection.connectionKind === 'vm' ? 'vm' : 'ssh-host';
  const configRead = readRemoteFleetSshTargetConfigForNode({
    targetKind,
    endpointUrl: envelope.connection.endpointUrl,
    publicConfig: envelope.connection.publicConfig,
  });
  if (configRead.resultType === 'valid') return configRead;
  return { resultType: 'failed', result: failedConnectionProbe(envelope, configRead.reason === 'invalid-config' ? 'invalid-config' : 'unsupported') };
}

async function readSshConnectionProbeAuthMaterial(
  envelope: RemoteFleetConnectionProbeEnvelope,
  context: RemoteFleetBootstrapProviderContext,
): Promise<SshConnectionProbeAuthReadResult> {
  const authRefRead = readRemoteFleetSshAuthSecretRef({ secretRefs: envelope.connection.secretRefs });
  if (authRefRead.resultType === 'failed') {
    return { resultType: 'failed', result: failedConnectionProbe(envelope, 'missing-secret') };
  }

  let readResult: RemoteFleetBootstrapSecretReadResult;
  try {
    readResult = await context.secrets.readSecret(authRefRead.auth.secretRefName);
  } catch {
    return { resultType: 'failed', result: failedConnectionProbe(envelope, 'unavailable') };
  }

  switch (readResult.resultType) {
    case 'resolved':
      if (readResult.plaintextSecretValue.trim().length === 0) {
        return { resultType: 'failed', result: failedConnectionProbe(envelope, 'missing-secret') };
      }
      return authRefRead.auth.authKind === 'private-key'
        ? { resultType: 'private-key', privateKey: readResult.plaintextSecretValue }
        : { resultType: 'password', password: readResult.plaintextSecretValue };
    case 'missing':
      return { resultType: 'failed', result: failedConnectionProbe(envelope, 'missing-secret') };
    case 'accessDenied':
      return { resultType: 'failed', result: failedConnectionProbe(envelope, 'auth') };
    case 'unavailable':
      return { resultType: 'failed', result: failedConnectionProbe(envelope, 'unavailable') };
  }
}

async function probeNode(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  deps: RemoteFleetSshBootstrapProviderDeps,
): Promise<RemoteFleetBootstrapCommandResult> {
  const provider = createRemoteFleetSshTerminalProvider({ createSshClient: deps.createSshClient });
  const result = await provider.open({
    session: {
      id: envelope.commandId,
      nodeId: envelope.nodeId,
      targetKind: envelope.node.targetKind,
      status: 'opening',
      createdAt: envelope.node.updatedAt,
      updatedAt: envelope.node.updatedAt,
    },
    node: envelope.node,
    rows: 1,
    cols: 80,
    secretResolver: bootstrapTerminalSecretResolver(envelope, context),
  });
  if (result.resultType !== 'opened') {
    return failedResult(envelope, sshTerminalFailureReason(result.reason), sshProbeFailureMessage(result.message));
  }
  result.handle.close();
  return {
    resultType: 'completed',
    commandId: envelope.commandId,
    providerKind: SSH_PROVIDER_KIND,
    message: 'Remote Fleet SSH node probe completed.',
  };
}

async function installAgent(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  config: RemoteFleetSshTargetConfig,
  deps: RemoteFleetSshBootstrapProviderDeps,
): Promise<RemoteFleetBootstrapCommandResult> {
  if (!envelope.enrollment) {
    return failedResult(envelope, 'invalid-config', 'Remote Fleet SSH install-agent requires an enrollment token.');
  }

  const authRead = await readSshAuthMaterial(envelope, context);
  if (authRead.resultType === 'failed') return authRead.result;

  const remoteCommand = buildInstallRemoteCommand(envelope.enrollment, config.installCommand);
  const secretValues = [...sshSecretValues(authRead), envelope.enrollment.token];
  const result = await executeSshExecCommand({
    config,
    auth: authRead,
    remoteCommand,
    secretValues,
    createSshClient: deps.createSshClient ?? createRemoteFleetSshClient,
  });

  if (result.resultType === 'failed') {
    return failedResult(envelope, result.reason, result.message);
  }

  return completedSshResult(
    envelope,
    'Remote Fleet SSH RuntimeAgent install command completed.',
    result.output,
    secretValues,
  );
}

async function executeSshExecCommand(input: {
  readonly config: RemoteFleetSshTargetConfig;
  readonly auth: Exclude<SshAuthMaterialReadResult, { readonly resultType: 'failed' }>;
  readonly remoteCommand: string;
  readonly secretValues: readonly string[];
  readonly createSshClient: RemoteFleetSshClientFactory;
}): Promise<SshExecCommandResult> {
  let client: RemoteFleetSshClient;
  try {
    client = await input.createSshClient();
  } catch (error) {
    return sshExecFailure('unavailable', error, input.secretValues);
  }

  return await new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let exitCode: number | undefined;
    let signal: string | undefined;
    const finish = (result: SshExecCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.end();
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish({
        resultType: 'failed',
        reason: 'timeout',
        message: 'Remote Fleet SSH command timed out.',
      });
    }, SSH_INSTALL_TIMEOUT_MS);

    client.on('ready', () => {
      try {
        client.exec(input.remoteCommand, (error, execStream) => {
          if (error || !execStream) {
            const reason = classifySshFailure(error);
            finish(sshExecFailure(reason, error, input.secretValues));
            return;
          }

          execStream.on('data', (chunk) => {
            stdout = appendBoundedOutput(stdout, chunkToString(chunk));
          });
          execStream.stderr?.on('data', (chunk) => {
            stderr = appendBoundedOutput(stderr, chunkToString(chunk));
          });
          execStream.on('error', (streamError) => {
            const reason = classifySshFailure(streamError);
            finish(sshExecFailure(reason, streamError, input.secretValues));
          });
          execStream.on('exit', (code, exitSignal) => {
            if (typeof code === 'number') exitCode = code;
            if (typeof exitSignal === 'string' && exitSignal.length > 0) signal = exitSignal;
          });
          execStream.on('close', (closeCode, closeSignal) => {
            if (typeof closeCode === 'number') exitCode = closeCode;
            if (typeof closeSignal === 'string' && closeSignal.length > 0) signal = closeSignal;
            if (exitCode !== undefined && exitCode !== 0) {
              finish(sshExecFailure('remote-error', { stdout, stderr, message: `Remote command exited with code ${exitCode}.` }, input.secretValues));
              return;
            }
            if (signal) {
              finish(sshExecFailure('remote-error', { stdout, stderr, message: `Remote command exited with signal ${signal}.` }, input.secretValues));
              return;
            }
            finish({ resultType: 'completed', output: { stdout, stderr, ...(exitCode === undefined ? {} : { exitCode }) } });
          });
        });
      } catch (error) {
        const reason = classifySshFailure(error);
        finish(sshExecFailure(reason, error, input.secretValues));
      }
    });

    client.on('error', (error) => {
      const reason = classifySshFailure(error);
      finish(sshExecFailure(reason, error, input.secretValues));
    });

    client.on('close', () => {
      finish(sshExecFailure('network', new Error('Remote Fleet SSH connection closed before install-agent command completed.'), input.secretValues));
    });

    try {
      client.connect(buildSshConnectConfig(input.config, input.auth));
    } catch (error) {
      const reason = classifySshFailure(error);
      finish(sshExecFailure(reason, error, input.secretValues));
    }
  });
}

function completedSshResult(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  successMessage: string,
  result: SshExecOutput,
  secretValues: readonly string[],
): RemoteFleetBootstrapCommandResult {
  return {
    resultType: 'completed',
    commandId: envelope.commandId,
    providerKind: SSH_PROVIDER_KIND,
    message: successMessage,
    ...optionalOutputSummary(result, secretValues),
  };
}

function buildSshConnectConfig(
  config: RemoteFleetSshTargetConfig,
  auth: Exclude<SshAuthMaterialReadResult, { readonly resultType: 'failed' }>,
): RemoteFleetSshClientConnectConfig {
  return {
    host: config.host,
    ...(config.port === undefined ? {} : { port: config.port }),
    ...(config.username ? { username: config.username } : {}),
    readyTimeout: SSH_CONNECT_READY_TIMEOUT_MS,
    ...(auth.resultType === 'private-key' ? { privateKey: auth.privateKey } : { password: auth.password }),
  };
}

function sshExecFailure(
  reason: RemoteFleetBootstrapFailureReason,
  error: unknown,
  secretValues: readonly string[],
): Extract<SshExecCommandResult, { readonly resultType: 'failed' }> {
  return {
    resultType: 'failed',
    reason,
    message: buildSshFailureMessage(reason, error, secretValues),
  };
}

function appendBoundedOutput(current: string, chunk: string): string {
  const combined = current + chunk;
  if (combined.length <= SSH_MAX_BUFFER_BYTES) return combined;
  return combined.slice(combined.length - SSH_MAX_BUFFER_BYTES);
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array || Buffer.isBuffer(chunk)) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

async function readSshAuthMaterial(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
): Promise<SshAuthMaterialReadResult> {
  const authRefRead = readRemoteFleetSshAuthSecretRef(
    envelope.connection ?? envelope.node,
    { operationLabel: 'bootstrap' },
  );
  if (authRefRead.resultType === 'failed') {
    return {
      resultType: 'failed',
      result: failedResult(envelope, authRefRead.reason, authRefRead.message),
    };
  }

  try {
    const readResult = await context.secrets.readSecret(authRefRead.auth.secretRefName);
    return authRefRead.auth.authKind === 'private-key'
      ? sshPrivateKeyResult(envelope, readResult)
      : sshPasswordResult(envelope, readResult);
  } catch {
    const message = authRefRead.auth.authKind === 'private-key'
      ? 'Remote Fleet SSH private key secret resolver is unavailable.'
      : 'Remote Fleet SSH password secret resolver is unavailable.';
    return {
      resultType: 'failed',
      result: failedResult(envelope, 'unavailable', message),
    };
  }
}

function sshPrivateKeyResult(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  readResult: RemoteFleetBootstrapSecretReadResult,
): SshAuthMaterialReadResult {
  return sshSecretReadResult(envelope, readResult, {
    credentialKind: 'private-key',
    emptyMessage: 'Remote Fleet SSH private key secret is empty.',
    missingMessage: 'Remote Fleet SSH private key secretRef is missing.',
    accessDeniedMessage: 'Remote Fleet SSH private key secretRef access was denied.',
    unavailableMessage: 'Remote Fleet SSH private key secret resolver is unavailable.',
  });
}

function sshPasswordResult(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  readResult: RemoteFleetBootstrapSecretReadResult,
): SshAuthMaterialReadResult {
  return sshSecretReadResult(envelope, readResult, {
    credentialKind: 'password',
    emptyMessage: 'Remote Fleet SSH password secret is empty.',
    missingMessage: 'Remote Fleet SSH password secretRef is missing.',
    accessDeniedMessage: 'Remote Fleet SSH password secretRef access was denied.',
    unavailableMessage: 'Remote Fleet SSH password secret resolver is unavailable.',
  });
}

function bootstrapTerminalSecretResolver(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
): RemoteFleetTerminalSecretResolver {
  return {
    async resolveSecret(input) {
      const secretRefName = secretRefNameForValue(envelope, input.secretRef);
      if (!secretRefName) {
        return { resultType: 'invalidRequest' };
      }
      const readResult = await context.secrets.readSecret(secretRefName);
      switch (readResult.resultType) {
        case 'resolved':
          return { resultType: 'resolved', plaintextSecretValue: readResult.plaintextSecretValue };
        case 'missing':
          return { resultType: 'notFound' };
        case 'accessDenied':
          return { resultType: 'accessDenied' };
        case 'unavailable':
          return { resultType: 'unavailable' };
      }
    },
  };
}

function secretRefNameForValue(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  secretRef: string,
): string | undefined {
  return Object.entries(envelope.node.secretRefs)
    .find(([, value]) => value.kind === 'secret-ref' && value.ref === secretRef)?.[0];
}

function sshSecretReadResult(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  readResult: RemoteFleetBootstrapSecretReadResult,
  messages: {
    readonly credentialKind: 'private-key' | 'password';
    readonly emptyMessage: string;
    readonly missingMessage: string;
    readonly accessDeniedMessage: string;
    readonly unavailableMessage: string;
  },
): SshAuthMaterialReadResult {
  switch (readResult.resultType) {
    case 'resolved': {
      if (readResult.plaintextSecretValue.trim().length === 0) {
        return {
          resultType: 'failed',
          result: failedResult(envelope, 'missing-secret', messages.emptyMessage),
        };
      }
      return messages.credentialKind === 'private-key'
        ? { resultType: 'private-key', privateKey: readResult.plaintextSecretValue }
        : { resultType: 'password', password: readResult.plaintextSecretValue };
    }
    case 'missing':
      return {
        resultType: 'failed',
        result: failedResult(envelope, 'missing-secret', messages.missingMessage),
      };
    case 'accessDenied':
      return {
        resultType: 'failed',
        result: failedResult(envelope, 'auth', messages.accessDeniedMessage),
      };
    case 'unavailable':
      return {
        resultType: 'failed',
        result: failedResult(envelope, 'unavailable', messages.unavailableMessage),
      };
  }
}

function readRemoteFleetSshTargetConfig(envelope: RemoteFleetBootstrapCommandEnvelope):
  | { readonly resultType: 'valid'; readonly config: RemoteFleetSshTargetConfig }
  | { readonly resultType: 'failed'; readonly result: RemoteFleetBootstrapCommandResult } {
  const configRead = envelope.connection
    ? readRemoteFleetSshConnectionConfigForConnection({
      connection: envelope.connection,
      targetKind: envelope.node.targetKind,
    }, { operationLabel: 'bootstrap' })
    : readRemoteFleetSshTargetConfigForNode(envelope.node, { operationLabel: 'bootstrap' });
  if (configRead.resultType === 'valid') return configRead;
  return {
    resultType: 'failed',
    result: failedResult(envelope, configRead.reason, configRead.message),
  };
}

function buildInstallRemoteCommand(enrollment: RemoteFleetBootstrapEnrollmentContext, installCommand: string): string {
  const envAssignments = [
    ['MATCHACLAW_ENROLLMENT_TOKEN', enrollment.token],
    ...(enrollment.callbackUrl ? [['MATCHACLAW_ENROLLMENT_CALLBACK_URL', enrollment.callbackUrl]] : []),
    ['MATCHACLAW_ENROLLMENT_EXPIRES_AT', enrollment.expiresAt],
    ['MATCHACLAW_AGENT_ID', enrollment.agentId],
    ['MATCHACLAW_NODE_ID', enrollment.nodeId],
  ].map(([name, value]) => `${name}=${shellQuote(value)}`).join(' ');
  return `${envAssignments} sh -lc ${shellQuote(installCommand)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function optionalOutputSummary(
  result: Pick<SshExecOutput, 'stdout' | 'stderr'>,
  secretValues: readonly string[],
): { readonly outputSummary?: string } {
  const summary = summarizeOutput([result.stdout, result.stderr], secretValues);
  return summary ? { outputSummary: summary } : {};
}

function summarizeOutput(values: readonly string[], secretValues: readonly string[]): string | undefined {
  const raw = values.map((value) => value.trim()).filter(Boolean).join('\n').trim();
  if (!raw) return undefined;
  const redacted = redactSecrets(raw, secretValues).replace(/\s+/g, ' ').trim();
  if (!redacted) return undefined;
  return redacted.length <= OUTPUT_SUMMARY_LIMIT ? redacted : `${redacted.slice(0, OUTPUT_SUMMARY_LIMIT)}...`;
}

function redactSecrets(value: string, secretValues: readonly string[]): string {
  let redacted = value;
  for (const secretValue of secretValues) {
    for (const token of secretRedactionCandidates(secretValue)) {
      redacted = redacted.split(token).join('[redacted]');
    }
  }
  return redacted
    .replace(/(MATCHACLAW_[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)[A-Z_]*=)([^\s'";]+)/g, '$1[redacted]')
    .replace(/(Authorization:\s*(?:Bearer|Basic)\s+)[^\s]+/gi, '$1[redacted]');
}

function secretRedactionCandidates(value: string): readonly string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  const candidates = new Set<string>([value, trimmed]);
  for (const line of value.split(/\r?\n/g)) {
    const candidate = line.trim();
    if (candidate.length >= 8) candidates.add(candidate);
  }
  return Array.from(candidates).filter((candidate) => candidate.length > 0);
}

function sshSecretValues(auth: Exclude<SshAuthMaterialReadResult, { readonly resultType: 'failed' }>): readonly string[] {
  return auth.resultType === 'private-key' ? [auth.privateKey] : [auth.password];
}

function sshTerminalFailureReason(reason: RemoteFleetSshTerminalFailureReason): RemoteFleetBootstrapFailureReason {
  switch (reason) {
    case 'notFound':
      return 'missing-secret';
    case 'accessDenied':
      return 'auth';
    default:
      return reason;
  }
}

function sshProbeFailureMessage(message: string): string {
  return message.replace(/terminal/g, 'bootstrap');
}

function classifySshFailure(error: unknown): RemoteFleetBootstrapFailureReason {
  const errorRecord = isRecord(error) ? error : {};
  const code = typeof errorRecord.code === 'string' ? errorRecord.code : undefined;
  const signal = typeof errorRecord.signal === 'string' ? errorRecord.signal : undefined;
  const killed = errorRecord.killed === true;
  const text = errorText(error).toLowerCase();

  if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') return 'unavailable';
  if (killed || signal === 'SIGTERM' || code === 'ETIMEDOUT' || text.includes('timed out') || text.includes('timeout')) {
    return 'timeout';
  }
  if (text.includes('permission denied')
    || text.includes('authentication failed')
    || text.includes('publickey')
    || text.includes('too many authentication failures')
    || text.includes('host key verification failed')) {
    return 'auth';
  }
  if (text.includes('could not resolve hostname')
    || text.includes('name or service not known')
    || text.includes('no route to host')
    || text.includes('network is unreachable')
    || text.includes('connection refused')
    || text.includes('connection closed')) {
    return 'network';
  }
  return 'remote-error';
}

function buildSshFailureMessage(
  reason: RemoteFleetBootstrapFailureReason,
  error: unknown,
  secretValues: readonly string[],
): string {
  const base = failureBaseMessage(reason);
  const summary = summarizeOutput([errorText(error)], secretValues);
  return summary ? `${base} ${summary}` : base;
}

function failureBaseMessage(reason: RemoteFleetBootstrapFailureReason): string {
  switch (reason) {
    case 'auth':
      return 'Remote Fleet SSH authentication failed.';
    case 'network':
      return 'Remote Fleet SSH network connection failed.';
    case 'timeout':
      return 'Remote Fleet SSH command timed out.';
    case 'unavailable':
      return 'Remote Fleet ssh2 bootstrap transport is unavailable.';
    case 'remote-error':
      return 'Remote Fleet SSH remote command failed.';
    case 'invalid-config':
    case 'missing-secret':
    case 'unsupported-target':
      return 'Remote Fleet SSH bootstrap failed.';
  }
}

function errorText(error: unknown): string {
  if (!isRecord(error)) return error instanceof Error ? error.message : String(error);
  const message = error instanceof Error
    ? error.message
    : typeof error.message === 'string' ? error.message : '';
  const stderr = typeof error.stderr === 'string' ? error.stderr : '';
  const stdout = typeof error.stdout === 'string' ? error.stdout : '';
  return [stderr, stdout, message].filter(Boolean).join('\n');
}

function classifySshConnectionProbeFailure(error: unknown): RemoteFleetConnectionProbeFailureReason {
  return classifySshFailure(error) === 'unsupported-target'
    ? 'unsupported'
    : classifySshFailure(error);
}

function failedConnectionProbe(
  envelope: Pick<RemoteFleetConnectionProbeEnvelope, 'commandId'>,
  reason: RemoteFleetConnectionProbeFailureReason,
): Extract<RemoteFleetConnectionProbeResult, { readonly resultType: 'failed' }> {
  return {
    resultType: 'failed',
    commandId: envelope.commandId,
    providerKind: SSH_PROVIDER_KIND,
    reason,
  };
}

function failedResult(
  envelope: Pick<RemoteFleetBootstrapCommandEnvelope, 'commandId'>,
  reason: RemoteFleetBootstrapFailureReason,
  message: string,
): Extract<RemoteFleetBootstrapCommandResult, { readonly resultType: 'failed' }> {
  return {
    resultType: 'failed',
    commandId: envelope.commandId,
    providerKind: SSH_PROVIDER_KIND,
    reason,
    message,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
