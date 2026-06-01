import type { z } from 'zod/v4'
import { type Node, PARSE_ABORTED } from 'src/utils/bash/parser.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import { BashTool } from './BashTool.js'
export type CommandIdentityCheckers = {
  isNormalizedCdCommand: (command: string) => boolean
  isNormalizedGitCommand: (command: string) => boolean
}
/**
 * Wrapper that resolves an IParsedCommand (from a pre-parsed AST root if
 * available, else via ParsedCommand.parse) and delegates to
 * bashToolCheckCommandOperatorPermissions.
 */
export declare function checkCommandOperatorPermissions(
  input: z.infer<typeof BashTool.inputSchema>,
  bashToolHasPermissionFn: (
    input: z.infer<typeof BashTool.inputSchema>,
  ) => Promise<PermissionResult>,
  checkers: CommandIdentityCheckers,
  astRoot: Node | null | typeof PARSE_ABORTED,
): Promise<PermissionResult>
