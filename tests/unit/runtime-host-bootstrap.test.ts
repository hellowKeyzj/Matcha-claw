import { describe, expect, it } from 'vitest';
import {
  buildRuntimeHostBootstrap,
  RuntimeHostBootstrapValidationError,
  type RuntimeHostBootstrapInput,
  type RuntimeHostBootstrapOpenClawInput,
  type UnixRuntimeHostBootstrapInput,
  type WindowsRuntimeHostBootstrapInput,
} from '../../electron/main/runtime-host-delivery/bootstrap';

function unixInput(
  overrides: Partial<Omit<UnixRuntimeHostBootstrapInput, 'platform'>> = {}
): UnixRuntimeHostBootstrapInput {
  return {
    platform: 'unix',
    appVersion: '1.0.4',
    appLogDir: '/var/lib/matcha/userdata/logs',
    runtimeHostStateDir: '/var/lib/matcha/runtime-host',
    runtimeHostMcpExecutable: '/opt/matcha/runtime-host-mcp',
    deliveryVerificationKey: 'MCowBQYDK2VwAyEAI3qD__Jv49yWsjljbNRbVm11047IMl5xFBflSPOROKE',
    parentCallbackBaseUrl: 'http://127.0.0.1:32110',
    parentCallbackDispatchToken: 'parent-callback-token',
    runtimeHostTransportPort: 32_111,
    matcha: {
      bunExecutable: '/opt/matcha/bun',
      entry: '/opt/matcha/app-server.mjs',
      workingDirectory: '/opt/matcha',
      storageRoot: '/var/lib/matcha',
      port: 31_001,
    },
    openClaw: {
      electronImage: '/opt/matcha/electron',
      workingDirectory: '/opt/matcha',
      openclawDir: '/opt/matcha/openclaw',
      companionSkillSourceRoot: '/opt/matcha/companion-skills',
      managedPluginRoot: '/opt/matcha/openclaw-plugins',
      subagentTemplateDir: '/opt/matcha/subagent-templates',
      entry: '/opt/matcha/openclaw/dist/index.js',
      stateDir: '/var/lib/matcha/openclaw',
      port: 31_002,
    },
    guardianExecutable: '/opt/matcha/runtime-host-guardian',
    ...overrides,
  };
}

function windowsInput(): WindowsRuntimeHostBootstrapInput {
  return {
    platform: 'win32',
    appVersion: '1.0.4',
    appLogDir: 'C:\\Users\\matcha\\AppData\\Roaming\\MatchaClaw\\logs',
    runtimeHostStateDir: 'C:\\Users\\matcha\\AppData\\Roaming\\MatchaClaw\\runtime-host',
    runtimeHostMcpExecutable: 'C:\\Matcha\\runtime-host-mcp.exe',
    deliveryVerificationKey: 'MCowBQYDK2VwAyEAI3qD__Jv49yWsjljbNRbVm11047IMl5xFBflSPOROKE',
    parentCallbackBaseUrl: 'http://127.0.0.1:32110',
    parentCallbackDispatchToken: 'parent-callback-token',
    runtimeHostTransportPort: 32_111,
    matcha: {
      bunExecutable: 'C:\\Matcha\\bun.exe',
      entry: 'C:\\Matcha\\app-server.mjs',
      workingDirectory: 'C:\\Matcha',
      storageRoot: 'C:\\ProgramData\\Matcha',
      port: 31_001,
      gitBash: 'C:\\Program Files\\Git\\bin\\bash.exe',
    },
    openClaw: {
      electronImage: 'C:\\Matcha\\electron.exe',
      workingDirectory: 'C:\\Matcha',
      openclawDir: 'C:\\Matcha\\openclaw',
      managedPluginRoot: 'C:\\Matcha\\openclaw-plugins',
      companionSkillSourceRoot: 'C:\\Matcha\\companion-skills',
      subagentTemplateDir: 'C:\\Matcha\\subagent-templates',
      entry: 'C:\\Matcha\\openclaw\\dist\\index.js',
      stateDir: 'C:\\ProgramData\\Matcha\\openclaw',
      port: 31_002,
    },
  };
}

function decodeBootstrap(input: RuntimeHostBootstrapInput): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(buildRuntimeHostBootstrap(input))) as Record<
    string,
    unknown
  >;
}

describe('buildRuntimeHostBootstrap', () => {
  it('encodes the exact unframed Unix Rust Wire payload with no unknown or sensitive fields', () => {
    const bytes = buildRuntimeHostBootstrap(unixInput());
    const payload = JSON.parse(new TextDecoder().decode(bytes));

    expect(bytes[0]).toBe('{'.charCodeAt(0));
    expect(Object.keys(payload)).toEqual([
      'version',
      'appVersion',
      'appLogDir',
      'runtimeHostStateDir',
      'runtimeHostMcpExecutable',
      'deliveryVerificationKey',
      'parentCallbackBaseUrl',
      'parentCallbackDispatchToken',
      'runtimeHostTransportPort',
      'matcha',
      'openClaw',
      'guardianExecutable',
    ]);
    expect(payload).toEqual({
      version: 1,
      appVersion: '1.0.4',
      appLogDir: '/var/lib/matcha/userdata/logs',
      runtimeHostStateDir: '/var/lib/matcha/runtime-host',
      runtimeHostMcpExecutable: '/opt/matcha/runtime-host-mcp',
      deliveryVerificationKey: 'MCowBQYDK2VwAyEAI3qD__Jv49yWsjljbNRbVm11047IMl5xFBflSPOROKE',
      parentCallbackBaseUrl: 'http://127.0.0.1:32110',
      parentCallbackDispatchToken: 'parent-callback-token',
      runtimeHostTransportPort: 32_111,
      matcha: {
        bunExecutable: '/opt/matcha/bun',
        entry: '/opt/matcha/app-server.mjs',
        workingDirectory: '/opt/matcha',
        storageRoot: '/var/lib/matcha',
        port: 31_001,
      },
      openClaw: {
        electronImage: '/opt/matcha/electron',
        workingDirectory: '/opt/matcha',
        openclawDir: '/opt/matcha/openclaw',
        companionSkillSourceRoot: '/opt/matcha/companion-skills',
        managedPluginRoot: '/opt/matcha/openclaw-plugins',
        subagentTemplateDir: '/opt/matcha/subagent-templates',
        entry: '/opt/matcha/openclaw/dist/index.js',
        stateDir: '/var/lib/matcha/openclaw',
        port: 31_002,
      },
      guardianExecutable: '/opt/matcha/runtime-host-guardian',
    });
    expect(payload).not.toHaveProperty('sessionTransportPort');
    expect(payload).not.toHaveProperty('sessionEventTransportPort');
    expect(payload).not.toHaveProperty('fleetTransportPort');
    expect(payload).not.toHaveProperty('token');
    expect(payload).not.toHaveProperty('authorization');
    expect(payload.matcha).not.toHaveProperty('token');
    expect(payload.openClaw).not.toHaveProperty('token');
    expect(payload.openClaw).not.toHaveProperty('skipChannels');
  });

  it('rejects obsolete skipChannels at the OpenClaw input type boundary', () => {
    const obsoleteOpenClawInput = {
      ...unixInput().openClaw,
      // @ts-expect-error skipChannels is not part of the bootstrap contract.
      skipChannels: true,
    } satisfies RuntimeHostBootstrapOpenClawInput;

    expect(obsoleteOpenClawInput.skipChannels).toBe(true);
  });

  it('omits obsolete skipChannels from an untyped OpenClaw runtime payload', () => {
    const input = unixInput();
    const payload = decodeBootstrap({
      ...input,
      openClaw: { ...input.openClaw, skipChannels: true } as RuntimeHostBootstrapInput['openClaw'],
    });

    expect(payload.openClaw).not.toHaveProperty('skipChannels');
  });

  it('preserves Windows-only gitBash and omits the Unix guardian field', () => {
    const payload = decodeBootstrap(windowsInput());

    expect(Object.keys(payload)).toEqual([
      'version',
      'appVersion',
      'appLogDir',
      'runtimeHostStateDir',
      'runtimeHostMcpExecutable',
      'deliveryVerificationKey',
      'parentCallbackBaseUrl',
      'parentCallbackDispatchToken',
      'runtimeHostTransportPort',
      'matcha',
      'openClaw',
    ]);
    expect(payload).toMatchObject({
      matcha: {
        gitBash: 'C:\\Program Files\\Git\\bin\\bash.exe',
      },
    });
    expect(payload).not.toHaveProperty('guardianExecutable');
  });

  it('preserves Unix-only guardianExecutable and omits the Windows gitBash field', () => {
    const payload = decodeBootstrap(unixInput());

    expect(payload).toHaveProperty('guardianExecutable', '/opt/matcha/runtime-host-guardian');
    expect(payload.matcha).not.toHaveProperty('gitBash');
  });

  it.each([
    ['empty appVersion', unixInput({ appVersion: '   ' }), 'appVersion'],
    [
      'relative Matcha path',
      unixInput({
        matcha: { ...unixInput().matcha, entry: 'relative/app-server.mjs' },
      }),
      'matcha.entry',
    ],
    [
      'NUL-containing OpenClaw path',
      unixInput({
        openClaw: { ...unixInput().openClaw, stateDir: '/var/lib/matcha\0openclaw' },
      }),
      'openClaw.stateDir',
    ],
    [
      'zero Matcha port',
      unixInput({
        matcha: { ...unixInput().matcha, port: 0 },
      }),
      'matcha.port',
    ],
    [
      'zero OpenClaw port',
      unixInput({
        openClaw: { ...unixInput().openClaw, port: 0 },
      }),
      'openClaw.port',
    ],
    [
      'zero runtime-host transport port',
      unixInput({ runtimeHostTransportPort: 0 }),
      'runtimeHostTransportPort',
    ],
    [
      'runtime-host transport port collides with Matcha app-server',
      unixInput({ runtimeHostTransportPort: 31_001 }),
      'ports',
    ],
    [
      'runtime-host transport port collides with OpenClaw gateway',
      unixInput({ runtimeHostTransportPort: 31_002 }),
      'ports',
    ],
    [
      'duplicate peer runtime ports',
      unixInput({
        openClaw: { ...unixInput().openClaw, port: unixInput().matcha.port },
      }),
      'ports',
    ],
    [
      'relative Unix guardian',
      unixInput({ guardianExecutable: 'runtime-host-guardian' }),
      'guardianExecutable',
    ],
    ['blank app log directory', unixInput({ appLogDir: '' }), 'appLogDir'],
    ['relative app log directory', unixInput({ appLogDir: 'userdata/logs' }), 'appLogDir'],
    ['relative runtime-host state directory', unixInput({ runtimeHostStateDir: 'runtime-host' }), 'runtimeHostStateDir'],
    ['relative runtime-host MCP executable', unixInput({ runtimeHostMcpExecutable: 'runtime-host-mcp' }), 'runtimeHostMcpExecutable'],
  ])('rejects %s', (_description, input, fieldName) => {
    expect(() => buildRuntimeHostBootstrap(input)).toThrow(
      new RuntimeHostBootstrapValidationError(fieldName)
    );
  });

  it('rejects a missing or malformed delivery verification key', () => {
    expect(() => buildRuntimeHostBootstrap(unixInput({ deliveryVerificationKey: '' }))).toThrow(
      new RuntimeHostBootstrapValidationError('deliveryVerificationKey')
    );
    expect(() =>
      buildRuntimeHostBootstrap(unixInput({ deliveryVerificationKey: 'private-key' }))
    ).toThrow(new RuntimeHostBootstrapValidationError('deliveryVerificationKey'));
  });

  it('rejects a missing Windows gitBash path', () => {
    const input = windowsInput();
    const matchaWithoutGitBash = { ...input.matcha, gitBash: '' };

    expect(() => buildRuntimeHostBootstrap({ ...input, matcha: matchaWithoutGitBash })).toThrow(
      new RuntimeHostBootstrapValidationError('matcha.gitBash')
    );
  });

  it('rejects a platform outside the Rust bootstrap contract', () => {
    const input = { ...unixInput(), platform: 'darwin' } as unknown as RuntimeHostBootstrapInput;

    expect(() => buildRuntimeHostBootstrap(input)).toThrow(
      new RuntimeHostBootstrapValidationError('platform')
    );
  });
});
