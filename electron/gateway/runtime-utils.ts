export function buildWindowsPortOwnerProbeScript(port: number): string {
  const localPort = Math.trunc(port);
  return [
    `$conn = Get-NetTCPConnection -State Listen -LocalPort ${localPort} -ErrorAction SilentlyContinue | Select-Object -First 1`,
    'if (-not $conn) {',
    "  [PSCustomObject]@{ occupied = $false } | ConvertTo-Json -Compress",
    '} else {',
    '  $ownerPid = [int]$conn.OwningProcess',
    '  $ownerProc = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue',
    '  $ownerCmd = if ($ownerProc) { [string]$ownerProc.CommandLine } else { "" }',
    '  [PSCustomObject]@{ occupied = $true; pid = $ownerPid; command = $ownerCmd } | ConvertTo-Json -Compress',
    '}',
  ].join('; ');
}

export function buildPosixPortOwnerProbeScript(port: number): string {
  const localPort = Math.trunc(port);
  return [
    `line=$(ss -H -ltnp "sport = :${localPort}" 2>/dev/null | head -n 1)`,
    'if [ -z "$line" ]; then',
    '  echo "0||"',
    '  exit 0',
    'fi',
    "pid=$(printf '%s' \"$line\" | sed -n 's/.*pid=\\([0-9][0-9]*\\).*/\\1/p')",
    'cmd=""',
    'if [ -n "$pid" ]; then',
    '  cmd=$(ps -p "$pid" -o args= 2>/dev/null | head -n 1)',
    'fi',
    'printf "1|%s|%s\\n" "$pid" "$cmd"',
  ].join('\n');
}

export function tryConvertPosixWslUncToWindowsPath(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replace(/\\/g, '/');
  const match = normalized.match(/^\/+wsl\.localhost\/([^/]+)\/(.+)$/i);
  if (!match) {
    return undefined;
  }
  const distro = match[1];
  const relative = match[2].replace(/^\/+/, '').replace(/\//g, '\\');
  return `\\\\wsl.localhost\\${distro}\\${relative}`;
}

export function isLikelyWslPortProxyCommand(command?: string): boolean {
  if (!command) {
    return false;
  }
  const normalized = command.toLowerCase();
  return (
    normalized.includes('wslhost') ||
    (normalized.includes('--vm-id') && normalized.includes('--handle'))
  );
}
