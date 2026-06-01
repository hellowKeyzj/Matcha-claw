/**
 * PowerShell-specific path validation for command arguments.
 *
 * Extracts file paths from PowerShell commands using the AST parser
 * and validates they stay within allowed project directories.
 * Follows the same patterns as BashTool/pathValidation.ts.
 */
import type { ToolPermissionContext } from 'src/Tool.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import type { ParsedPowerShellCommand } from 'src/utils/powershell/parser.js'
/**
 * Checks the raw user-provided path (pre-realpath) for dangerous removal
 * targets. safeResolvePath/realpathSync canonicalizes in ways that defeat
 * isDangerousRemovalPath: on Windows '/' → 'C:\' (fails the === '/' check);
 * on macOS homedir() may be under /var which realpathSync rewrites to
 * /private/var (fails the === homedir() check). Checking the tilde-expanded,
 * backslash-normalized form catches the dangerous shapes (/, ~, /etc, /usr)
 * as the user typed them.
 */
export declare function isDangerousRemovalRawPath(filePath: string): boolean
export declare function dangerousRemovalDeny(path: string): PermissionResult
/**
 * Checks path constraints for PowerShell commands.
 * Extracts file paths from the parsed AST and validates they are
 * within allowed directories.
 *
 * @param compoundCommandHasCd - Whether the full compound command contains a
 *   cwd-changing cmdlet (Set-Location/Push-Location/Pop-Location/New-PSDrive,
 *   excluding no-op Set-Location-to-CWD). When true, relative paths in ANY
 *   statement cannot be trusted — PowerShell executes statements sequentially
 *   and a cd in statement N changes the cwd for statement N+1, but this
 *   validator resolves all paths against the stale Node process cwd.
 *   BashTool parity (BashTool/pathValidation.ts:630-655).
 *
 * @returns
 * - 'ask' if any path command tries to access outside allowed directories
 * - 'deny' if a deny rule explicitly blocks the path
 * - 'passthrough' if no path commands were found or all paths are valid
 */
export declare function checkPathConstraints(
  input: {
    command: string
  },
  parsed: ParsedPowerShellCommand,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult
