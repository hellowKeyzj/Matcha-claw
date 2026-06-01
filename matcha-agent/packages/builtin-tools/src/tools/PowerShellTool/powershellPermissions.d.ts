/**
 * PowerShell-specific permission checking, adapted from bashPermissions.ts
 * for case-insensitive cmdlet matching.
 */
import type { ToolPermissionContext, ToolUseContext } from 'src/Tool.js'
import type { PermissionResult } from 'src/types/permissions.js'
import { type ShellPermissionRule } from 'src/utils/permissions/shellRuleMatching.js'
/**
 * Parse a permission rule string into a structured rule object.
 * Delegates to shared parsePermissionRule.
 */
export declare function powershellPermissionRule(
  permissionRule: string,
): ShellPermissionRule
/**
 * PowerShell input schema type - simplified for initial implementation
 */
type PowerShellInput = {
  command: string
  timeout?: number
}
/**
 * Check if the command is an exact match for a permission rule.
 */
export declare function powershellToolCheckExactMatchPermission(
  input: PowerShellInput,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult
/**
 * Check permission for a PowerShell command including prefix matches.
 */
export declare function powershellToolCheckPermission(
  input: PowerShellInput,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult
/**
 * Main permission check function for PowerShell tool.
 *
 * This function implements the full permission flow:
 * 1. Check exact match against deny/ask/allow rules
 * 2. Check prefix match against rules
 * 3. Run security check via powershellCommandIsSafe()
 * 4. Return appropriate PermissionResult
 *
 * @param input - The PowerShell tool input
 * @param context - The tool use context (for abort signal and session info)
 * @returns Promise resolving to PermissionResult
 */
export declare function powershellToolHasPermission(
  input: PowerShellInput,
  context: ToolUseContext,
): Promise<PermissionResult>
export {}
