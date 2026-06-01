import type { z } from 'zod/v4'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import type { BashTool } from './BashTool.js'
/**
 * Unified command validation function that replaces individual validator functions.
 * Uses declarative configuration from COMMAND_ALLOWLIST to validate commands and their flags.
 * Handles combined flags, argument validation, and shell quoting bypass detection.
 */
export declare function isCommandSafeViaFlagParsing(command: string): boolean
/**
 * Checks read-only constraints for bash commands.
 * This is the single exported function that validates whether a command is read-only.
 * It handles compound commands, sandbox mode, and safety checks.
 *
 * @param input The bash command input to validate
 * @param compoundCommandHasCd Pre-computed flag indicating if any cd command exists in the compound command.
 *                              This is computed by commandHasAnyCd() and passed in to avoid duplicate computation.
 * @returns PermissionResult indicating whether the command is read-only
 */
export declare function checkReadOnlyConstraints(
  input: z.infer<typeof BashTool.inputSchema>,
  compoundCommandHasCd: boolean,
): PermissionResult
