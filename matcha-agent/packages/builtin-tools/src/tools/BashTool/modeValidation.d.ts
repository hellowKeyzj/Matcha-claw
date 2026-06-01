import type { z } from 'zod/v4'
import type { ToolPermissionContext } from 'src/Tool.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import type { BashTool } from './BashTool.js'
/**
 * Checks if commands should be handled differently based on the current permission mode
 *
 * This is the main entry point for mode-based permission logic.
 * Currently handles Accept Edits mode for filesystem commands,
 * but designed to be extended for other modes.
 *
 * @param input - The bash command input
 * @param toolPermissionContext - Context containing mode and permissions
 * @returns
 * - 'allow' if the current mode permits auto-approval
 * - 'ask' if the command needs approval in current mode
 * - 'passthrough' if no mode-specific handling applies
 */
export declare function checkPermissionMode(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult
export declare function getAutoAllowedCommands(
  mode: ToolPermissionContext['mode'],
): readonly string[]
