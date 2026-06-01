import type { z } from 'zod/v4'
import type { ToolPermissionContext } from 'src/Tool.js'
import type { Redirect, SimpleCommand } from 'src/utils/bash/ast.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import { type FileOperationType } from 'src/utils/permissions/pathValidation.js'
import type { BashTool } from './BashTool.js'
export type PathCommand =
  | 'cd'
  | 'ls'
  | 'find'
  | 'mkdir'
  | 'touch'
  | 'rm'
  | 'rmdir'
  | 'mv'
  | 'cp'
  | 'cat'
  | 'head'
  | 'tail'
  | 'sort'
  | 'uniq'
  | 'wc'
  | 'cut'
  | 'paste'
  | 'column'
  | 'tr'
  | 'file'
  | 'stat'
  | 'diff'
  | 'awk'
  | 'strings'
  | 'hexdump'
  | 'od'
  | 'base64'
  | 'nl'
  | 'grep'
  | 'rg'
  | 'sed'
  | 'git'
  | 'jq'
  | 'sha256sum'
  | 'sha1sum'
  | 'md5sum'
/**
 * Extracts paths from command arguments for different path commands.
 * Each command has specific logic for how it handles paths and flags.
 */
export declare const PATH_EXTRACTORS: Record<
  PathCommand,
  (args: string[]) => string[]
>
export declare const COMMAND_OPERATION_TYPE: Record<
  PathCommand,
  FileOperationType
>
export declare function createPathChecker(
  command: PathCommand,
  operationTypeOverride?: FileOperationType,
): (
  args: string[],
  cwd: string,
  context: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
) => PermissionResult
/**
 * Checks path constraints for commands that access the filesystem (cd, ls, find).
 * Also validates output redirections to ensure they're within allowed directories.
 *
 * @returns
 * - 'ask' if any path command or redirection tries to access outside allowed directories
 * - 'passthrough' if no path commands were found or if all are within allowed directories
 */
export declare function checkPathConstraints(
  input: z.infer<typeof BashTool.inputSchema>,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
  astRedirects?: Redirect[],
  astCommands?: SimpleCommand[],
): PermissionResult
/**
 * Argv-level counterpart to stripSafeWrappers (bashPermissions.ts). Strips
 * wrapper commands from AST-derived argv. Env vars are already separated
 * into SimpleCommand.envVars so no env-var stripping here.
 */
export declare function stripWrappersFromArgv(argv: string[]): string[]
