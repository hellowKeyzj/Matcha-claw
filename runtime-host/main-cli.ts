#!/usr/bin/env node

async function runMatchaCli(argv: readonly string[]): Promise<number> {
  const commandTokens = stripOptionalExecutablePrefix(argv);
  const command = commandTokens[0];

  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(formatMatchaCliUsage());
    return 0;
  }

  if (command === 'runtime') {
    const { runMatchaRuntimeCommand } = await import('./application/runtime-cli/matcha-runtime-command');
    return (await runMatchaRuntimeCommand(commandTokens, {
      stdout: process.stdout,
      stderr: process.stderr,
    })).exitCode;
  }

  if (command === 'system-runtime') {
    const { runSystemRuntimeMcpServerCommand } = await import('./application/runtime-cli/system-runtime-mcp-server-command');
    return await runSystemRuntimeMcpServerCommand(commandTokens, {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
  }

  process.stderr.write(`Unknown matcha command "${command}". Use: matcha runtime invoke | matcha system-runtime mcp-stdio\n`);
  return 2;
}

function stripOptionalExecutablePrefix(argv: readonly string[]): readonly string[] {
  return argv[0] === 'matcha' ? argv.slice(1) : argv;
}

function formatMatchaCliUsage(): string {
  return [
    'Usage:',
    '  matcha runtime invoke --id <capability> --scope <json> --operation <id> --target <json|null> --input <json> [--json]',
    '  matcha system-runtime mcp-stdio [--runtime-host-url <url>] [--timeout-ms <ms>]',
    '',
    'Runtime commands are provider-neutral shells. Business execution must be backed by runtime-host capabilities.',
  ].join('\n') + '\n';
}

void runMatchaCli(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[matcha-cli] failed to start: ${detail}\n`);
    process.exitCode = 1;
  });
