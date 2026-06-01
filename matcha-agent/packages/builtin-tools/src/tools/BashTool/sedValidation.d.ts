import type { ToolPermissionContext } from 'src/Tool.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
/**
 * Checks if a sed command is allowed by the allowlist.
 * The allowlist patterns themselves are strict enough to reject dangerous operations.
 * @param command The sed command to check
 * @param options.allowFileWrites When true, allows -i flag and file arguments for substitution commands
 * @returns true if the command is allowed (matches allowlist and passes denylist check), false otherwise
 */
export declare function sedCommandIsAllowedByAllowlist(
  command: string,
  options?: {
    allowFileWrites?: boolean
  },
): boolean
/**
 * Cross-cutting validation step for sed commands.
 *
 * This is a constraint check that blocks dangerous sed operations regardless of mode.
 * It returns 'passthrough' for non-sed commands or safe sed commands,
 * and 'ask' for dangerous sed operations (w/W/e/E commands).
 *
 * @param input - Object containing the command string
 * @param toolPermissionContext - Context containing mode and permissions
 * @returns
 * - 'ask' if any sed command contains dangerous operations
 * - 'passthrough' if no sed commands or all are safe
 */
export declare function checkSedConstraints(
  input: {
    command: string
  },
  toolPermissionContext: ToolPermissionContext,
): PermissionResult
