/**
 * PowerShell permission mode validation.
 *
 * Checks if commands should be auto-allowed based on the current permission mode.
 * In acceptEdits mode, filesystem-modifying PowerShell cmdlets are auto-allowed.
 * Follows the same patterns as BashTool/modeValidation.ts.
 */
import type { ToolPermissionContext } from 'src/Tool.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import type { ParsedPowerShellCommand } from 'src/utils/powershell/parser.js'
/**
 * Detects New-Item creating a filesystem link (-ItemType SymbolicLink /
 * Junction / HardLink, or the -Type alias). Links poison subsequent path
 * resolution the same way Set-Location/New-PSDrive do: a relative path
 * through the link resolves to the link target, not the validator's view.
 * Finding #18.
 *
 * Handles PS parameter abbreviation (`-it`, `-ite`, ... `-itemtype`; `-ty`,
 * `-typ`, `-type`), unicode dash prefixes (en-dash/em-dash/horizontal-bar),
 * and colon-bound values (`-it:Junction`).
 */
export declare function isSymlinkCreatingCommand(cmd: {
  name: string
  args: string[]
}): boolean
/**
 * Checks if commands should be handled differently based on the current permission mode.
 *
 * In acceptEdits mode, auto-allows filesystem-modifying PowerShell cmdlets.
 * Uses the AST to resolve aliases before checking the allowlist.
 *
 * @param input - The PowerShell command input
 * @param parsed - The parsed AST of the command
 * @param toolPermissionContext - Context containing mode and permissions
 * @returns
 * - 'allow' if the current mode permits auto-approval
 * - 'passthrough' if no mode-specific handling applies
 */
export declare function checkPermissionMode(
  input: {
    command: string
  },
  parsed: ParsedPowerShellCommand,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult
