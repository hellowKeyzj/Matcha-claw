import { pathToFileURL } from 'node:url';
import { resolveOpenClawRuntimeModulePath } from '../../../utils/runtime-package-resolution';

// OpenClaw 2026.9.2 anthropic/cli-constants.ts: native login must not inherit
// another provider's routing or injected credential transport. Keep CLAUDE_CONFIG_DIR.
const CLEAR_ENV = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_OLD', 'ANTHROPIC_API_TOKEN',
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING', 'MAX_THINKING_TOKENS',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR', 'CLAUDE_CODE_PLUGIN_SEED_DIR',
  'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_USE_COWORK_PLUGINS',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_VERTEX',
  'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS', 'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS', 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL',
  'OTEL_LOGS_EXPORTER', 'OTEL_METRICS_EXPORTER', 'OTEL_SDK_DISABLED', 'OTEL_TRACES_EXPORTER',
]);

type SpawnProgram = { command: string; leadingArgv: string[]; resolution: string };
type WindowsSpawn = {
  resolveWindowsSpawnProgram(input: {
    command: string; env: NodeJS.ProcessEnv; packageName: string;
  }): SpawnProgram;
  materializeWindowsSpawnProgram(program: SpawnProgram, argv: string[]): { command: string; argv: string[] };
};
type ProcessRuntime = {
  runUtf8CommandWithTimeout(argv: string[], options: {
    baseEnv: NodeJS.ProcessEnv;
    maxOutputBytes: number;
    maxCombinedOutputBytes: number;
    terminateOnOutputLimit: boolean;
    timeoutMs: number;
    killProcessTree: boolean;
  }): Promise<{ termination: string; code: number | null; stdout: string }>;
};

export async function probeAnthropicCliAuth(): Promise<'available' | 'missing' | 'unreadable'> {
  try {
    const [runtime, windows] = await Promise.all([
      import(pathToFileURL(resolveOpenClawRuntimeModulePath('openclaw/plugin-sdk/process-runtime')).href) as Promise<ProcessRuntime>,
      import(pathToFileURL(resolveOpenClawRuntimeModulePath('openclaw/plugin-sdk/windows-spawn')).href) as Promise<WindowsSpawn>,
    ]);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !CLEAR_ENV.has(key.toUpperCase())));
    const program = windows.resolveWindowsSpawnProgram({
      command: 'claude', env, packageName: '@anthropic-ai/claude-code',
    });
    // Windows npm shims resolve to process.execPath, which is Electron in Main.
    if (program.resolution === 'node-entrypoint') env.ELECTRON_RUN_AS_NODE = '1';
    const invocation = windows.materializeWindowsSpawnProgram(program, ['auth', 'status', '--json']);
    const result = await runtime.runUtf8CommandWithTimeout([invocation.command, ...invocation.argv], {
      baseEnv: env,
      maxOutputBytes: 64 * 1024,
      maxCombinedOutputBytes: 64 * 1024,
      terminateOnOutputLimit: true,
      timeoutMs: 3_000,
      killProcessTree: true,
    });
    if (result.termination !== 'exit' || result.code === null) return 'unreadable';
    if (result.code !== 0) return 'missing';
    const status: unknown = JSON.parse(result.stdout);
    return status !== null && typeof status === 'object' && 'loggedIn' in status && status.loggedIn === true
      ? 'available' : 'missing';
  } catch {
    return 'unreadable';
  }
}
