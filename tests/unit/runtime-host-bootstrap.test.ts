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
    deliveryVerificationKey: 'MCowBQYDK2VwAyEAI3qD__Jv49yWsjljbNRbVm11047IMl5xFBflSPOROKE',
    cronBrokerVerificationKey: 'MCowBQYDK2VwAyEAI3qD__Jv49yWsjljbNRbVm11047IMl5xFBflSPOROKE',
    parentCallbackBaseUrl: 'http://127.0.0.1:32110',
    parentCallbackDispatchToken: 'parent-callback-token',
    sessionTransportPort: 32_111,
    fleetTransportPort: 32_112,
    diagnosticsTransportPort: 32_113,
    workspaceTextTransportPort: 32_114,
    workspaceBinaryTransportPort: 32_132,
    workspaceDirectoryTransportPort: 32_115,
    workspaceWriteTransportPort: 32_116,
    workspaceMediaTransportPort: 32_142,
    sessionSendTransportPort: 32_117,
    sessionAbortTransportPort: 32_118,
    securityEmergencyTransportPort: 32_119,
    channelStatusTransportPort: 32_120,
    channelCatalogTransportPort: 32_148,
    channelControlTransportPort: 32_143,
    channelPairingTransportPort: 32_139,
    settingsDesiredTransportPort: 32_136,
    securityPolicyTransportPort: 32_137,
    sessionApprovalTransportPort: 32_121,
    openclawHistoryTransportPort: 32_123,
    matchaHistoryTransportPort: 32_146,
    usageTransportPort: 32_145,
    sessionModelSelectionTransportPort: 32_124,
    cronTransportPort: 32_125,
    cronBrokerTransportPort: 32_150,
    taskManagerTransportPort: 32_147,
    agentsTransportPort: 32_126,
    teamPublicTransportPort: 32_127,
    teamTaskBoardTransportPort: 32_149,
    teamRoleSessionsTransportPort: 32_144,
    teamApprovalsTransportPort: 32_141,
    teamDecisionTransportPort: 32_134,
    teamRoleChatTransportPort: 32_138,
    providerModelsTransportPort: 32_128,
    providerAccountsTransportPort: 32_140,
    teamGraphTransportPort: 32_129,
    teamSkillTransportPort: 32_130,
    teamTriggerTransportPort: 32_131,
    teamLifecycleTransportPort: 32_133,
    manualTeamTransportPort: 32_135,
    matcha: {
      bunExecutable: '/opt/matcha/bun',
      entry: '/opt/matcha/app-server.mjs',
      workingDirectory: '/opt/matcha',
      storageRoot: '/var/lib/matcha',
      port: 31_001,
      privateSecretRoot: '/var/lib/matcha/private',
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
    sshAuthoritySourcePath: 'C:\\ProgramData\\Matcha\\fleet\\ssh-authority.json',
    sshOperatorVerificationKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    deliveryVerificationKey: 'MCowBQYDK2VwAyEAI3qD__Jv49yWsjljbNRbVm11047IMl5xFBflSPOROKE',
    cronBrokerVerificationKey: 'MCowBQYDK2VwAyEAI3qD__Jv49yWsjljbNRbVm11047IMl5xFBflSPOROKE',
    parentCallbackBaseUrl: 'http://127.0.0.1:32110',
    parentCallbackDispatchToken: 'parent-callback-token',
    sessionTransportPort: 32_111,
    fleetTransportPort: 32_112,
    diagnosticsTransportPort: 32_113,
    workspaceTextTransportPort: 32_114,
    workspaceBinaryTransportPort: 32_132,
    workspaceDirectoryTransportPort: 32_115,
    workspaceWriteTransportPort: 32_116,
    workspaceMediaTransportPort: 32_142,
    sessionSendTransportPort: 32_117,
    sessionAbortTransportPort: 32_118,
    securityEmergencyTransportPort: 32_119,
    channelStatusTransportPort: 32_120,
    channelCatalogTransportPort: 32_148,
    channelControlTransportPort: 32_143,
    channelPairingTransportPort: 32_139,
    settingsDesiredTransportPort: 32_136,
    securityPolicyTransportPort: 32_137,
    sessionApprovalTransportPort: 32_121,
    openclawHistoryTransportPort: 32_123,
    matchaHistoryTransportPort: 32_146,
    usageTransportPort: 32_145,
    sessionModelSelectionTransportPort: 32_124,
    cronTransportPort: 32_125,
    cronBrokerTransportPort: 32_150,
    taskManagerTransportPort: 32_147,
    agentsTransportPort: 32_126,
    teamPublicTransportPort: 32_127,
    teamTaskBoardTransportPort: 32_149,
    teamRoleSessionsTransportPort: 32_144,
    teamApprovalsTransportPort: 32_141,
    teamDecisionTransportPort: 32_134,
    teamRoleChatTransportPort: 32_138,
    providerModelsTransportPort: 32_128,
    providerAccountsTransportPort: 32_140,
    teamGraphTransportPort: 32_129,
    teamSkillTransportPort: 32_130,
    teamTriggerTransportPort: 32_131,
    teamLifecycleTransportPort: 32_133,
    manualTeamTransportPort: 32_135,
    matcha: {
      bunExecutable: 'C:\\Matcha\\bun.exe',
      entry: 'C:\\Matcha\\app-server.mjs',
      workingDirectory: 'C:\\Matcha',
      storageRoot: 'C:\\ProgramData\\Matcha',
      port: 31_001,
      privateSecretRoot: 'C:\\ProgramData\\Matcha\\private',
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
      'deliveryVerificationKey',
      'cronBrokerVerificationKey',
      'parentCallbackBaseUrl',
      'parentCallbackDispatchToken',
      'sessionTransportPort',
      'fleetTransportPort',
      'diagnosticsTransportPort',
      'workspaceTextTransportPort',
      'workspaceBinaryTransportPort',
      'workspaceDirectoryTransportPort',
      'workspaceWriteTransportPort',
      'workspaceMediaTransportPort',
      'sessionSendTransportPort',
      'sessionAbortTransportPort',
      'securityEmergencyTransportPort',
      'channelStatusTransportPort',
      'channelCatalogTransportPort',
      'channelControlTransportPort',
      'channelPairingTransportPort',
      'settingsDesiredTransportPort',
      'securityPolicyTransportPort',
      'sessionApprovalTransportPort',
      'openclawHistoryTransportPort',
      'matchaHistoryTransportPort',
      'usageTransportPort',
      'sessionModelSelectionTransportPort',
      'cronTransportPort',
      'cronBrokerTransportPort',
      'taskManagerTransportPort',
      'agentsTransportPort',
      'teamPublicTransportPort',
      'teamTaskBoardTransportPort',
      'teamRoleSessionsTransportPort',
      'teamApprovalsTransportPort',
      'teamDecisionTransportPort',
      'teamRoleChatTransportPort',
      'teamGraphTransportPort',
      'providerModelsTransportPort',
      'providerAccountsTransportPort',
      'teamSkillTransportPort',
      'teamTriggerTransportPort',
      'teamLifecycleTransportPort',
      'manualTeamTransportPort',
      'matcha',
      'openClaw',
      'guardianExecutable',
    ]);
    expect(payload).toEqual({
      version: 1,
      appVersion: '1.0.4',
      appLogDir: '/var/lib/matcha/userdata/logs',
      runtimeHostStateDir: '/var/lib/matcha/runtime-host',
      deliveryVerificationKey: 'MCowBQYDK2VwAyEAI3qD__Jv49yWsjljbNRbVm11047IMl5xFBflSPOROKE',
      cronBrokerVerificationKey: 'MCowBQYDK2VwAyEAI3qD__Jv49yWsjljbNRbVm11047IMl5xFBflSPOROKE',
      parentCallbackBaseUrl: 'http://127.0.0.1:32110',
      parentCallbackDispatchToken: 'parent-callback-token',
      sessionTransportPort: 32_111,
      fleetTransportPort: 32_112,
      diagnosticsTransportPort: 32_113,
      workspaceTextTransportPort: 32_114,
      workspaceBinaryTransportPort: 32_132,
      workspaceDirectoryTransportPort: 32_115,
      workspaceWriteTransportPort: 32_116,
      workspaceMediaTransportPort: 32_142,
      sessionSendTransportPort: 32_117,
      sessionAbortTransportPort: 32_118,
      securityEmergencyTransportPort: 32_119,
      channelStatusTransportPort: 32_120,
      channelCatalogTransportPort: 32_148,
      channelControlTransportPort: 32_143,
      channelPairingTransportPort: 32_139,
      settingsDesiredTransportPort: 32_136,
      securityPolicyTransportPort: 32_137,
      sessionApprovalTransportPort: 32_121,
      openclawHistoryTransportPort: 32_123,
      matchaHistoryTransportPort: 32_146,
      usageTransportPort: 32_145,
      sessionModelSelectionTransportPort: 32_124,
      cronTransportPort: 32_125,
      cronBrokerTransportPort: 32_150,
      taskManagerTransportPort: 32_147,
      agentsTransportPort: 32_126,
      teamPublicTransportPort: 32_127,
      teamTaskBoardTransportPort: 32_149,
      teamRoleSessionsTransportPort: 32_144,
      teamApprovalsTransportPort: 32_141,
      teamDecisionTransportPort: 32_134,
      teamRoleChatTransportPort: 32_138,
      teamGraphTransportPort: 32_129,
      providerModelsTransportPort: 32_128,
      providerAccountsTransportPort: 32_140,
      teamSkillTransportPort: 32_130,
      teamTriggerTransportPort: 32_131,
      teamLifecycleTransportPort: 32_133,
      manualTeamTransportPort: 32_135,
      matcha: {
        bunExecutable: '/opt/matcha/bun',
        entry: '/opt/matcha/app-server.mjs',
        workingDirectory: '/opt/matcha',
        storageRoot: '/var/lib/matcha',
        port: 31_001,
        privateSecretRoot: '/var/lib/matcha/private',
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
    expect(JSON.stringify(payload)).not.toContain('transportPort');
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
      'deliveryVerificationKey',
      'cronBrokerVerificationKey',
      'parentCallbackBaseUrl',
      'parentCallbackDispatchToken',
      'sessionTransportPort',
      'fleetTransportPort',
      'diagnosticsTransportPort',
      'workspaceTextTransportPort',
      'workspaceBinaryTransportPort',
      'workspaceDirectoryTransportPort',
      'workspaceWriteTransportPort',
      'workspaceMediaTransportPort',
      'sessionSendTransportPort',
      'sessionAbortTransportPort',
      'securityEmergencyTransportPort',
      'channelStatusTransportPort',
      'channelCatalogTransportPort',
      'channelControlTransportPort',
      'channelPairingTransportPort',
      'settingsDesiredTransportPort',
      'securityPolicyTransportPort',
      'sessionApprovalTransportPort',
      'openclawHistoryTransportPort',
      'matchaHistoryTransportPort',
      'usageTransportPort',
      'sessionModelSelectionTransportPort',
      'cronTransportPort',
      'cronBrokerTransportPort',
      'taskManagerTransportPort',
      'agentsTransportPort',
      'teamPublicTransportPort',
      'teamTaskBoardTransportPort',
      'teamRoleSessionsTransportPort',
      'teamApprovalsTransportPort',
      'teamDecisionTransportPort',
      'teamRoleChatTransportPort',
      'teamGraphTransportPort',
      'providerModelsTransportPort',
      'providerAccountsTransportPort',
      'teamSkillTransportPort',
      'teamTriggerTransportPort',
      'teamLifecycleTransportPort',
      'manualTeamTransportPort',
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
      'duplicate transport ports',
      unixInput({ diagnosticsTransportPort: 32_111 }),
      'transportPorts',
    ],
    [
      'workspace text port collides with a transport',
      unixInput({ workspaceTextTransportPort: 32_113 }),
      'transportPorts',
    ],
    [
      'session send port collides with a transport',
      unixInput({ sessionSendTransportPort: 32_111 }),
      'transportPorts',
    ],
    [
      'usage transport port collides with a transport',
      unixInput({ usageTransportPort: 32_111 }),
      'transportPorts',
    ],
    [
      'Matcha history transport port collides with a peer runtime',
      unixInput({ matchaHistoryTransportPort: 31_001 }),
      'ports',
    ],
    [
      'Task Manager transport port collides with a peer runtime',
      unixInput({ taskManagerTransportPort: 31_001 }),
      'ports',
    ],
    [
      'Team decision port collides with a transport',
      unixInput({ teamDecisionTransportPort: 32_111 }),
      'transportPorts',
    ],
    [
      'Team role-chat port collides with a transport',
      unixInput({ teamRoleChatTransportPort: 32_111 }),
      'transportPorts',
    ],
    [
      'Team graph port collides with a transport',
      unixInput({ teamGraphTransportPort: 32_111 }),
      'transportPorts',
    ],
    [
      'TeamSkill port collides with a transport',
      unixInput({ teamSkillTransportPort: 32_111 }),
      'transportPorts',
    ],
    [
      'Team trigger port collides with a transport',
      unixInput({ teamTriggerTransportPort: 32_111 }),
      'transportPorts',
    ],
    [
      'Team lifecycle port collides with a transport',
      unixInput({ teamLifecycleTransportPort: 32_111 }),
      'transportPorts',
    ],
    [
      'Manual Team port collides with a transport',
      unixInput({ manualTeamTransportPort: 32_111 }),
      'transportPorts',
    ],
    [
      'transport port collides with a peer runtime',
      unixInput({ diagnosticsTransportPort: 31_001 }),
      'ports',
    ],
    [
      'workspace text port collides with a peer runtime',
      unixInput({ workspaceTextTransportPort: 31_002 }),
      'ports',
    ],
    [
      'duplicate ports',
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
