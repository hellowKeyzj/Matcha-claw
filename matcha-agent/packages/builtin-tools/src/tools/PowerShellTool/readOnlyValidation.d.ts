/**
 * PowerShell read-only command validation.
 *
 * Cmdlets are case-insensitive; all matching is done in lowercase.
 */
import type {
  ParsedCommandElement,
  ParsedPowerShellCommand,
} from 'src/utils/powershell/parser.js'
type ParsedStatement = ParsedPowerShellCommand['statements'][number]
type CommandConfig = {
  /** Safe subcommands or flags for this command */
  safeFlags?: string[]
  /**
   * When true, all flags are allowed regardless of safeFlags.
   * Use for commands whose entire flag surface is read-only (e.g., hostname).
   * Without this, an empty/missing safeFlags rejects all flags (positional
   * args only).
   */
  allowAllFlags?: boolean
  /** Regex constraint on the original command */
  regex?: RegExp
  /** Additional validation callback - returns true if command is dangerous */
  additionalCommandIsDangerousCallback?: (
    command: string,
    element?: ParsedCommandElement,
  ) => boolean
}
/**
 * Shared callback for cmdlets that print or coerce their args to stdout/
 * stderr. `Write-Output $env:SECRET` prints it directly; `Start-Sleep
 * $env:SECRET` leaks via type-coerce error ("Cannot convert value 'sk-...'
 * to System.Double"). Bash's echo regex WHITELISTS safe chars per token.
 *
 * Two checks:
 * 1. elementTypes whitelist — StringConstant (literals) + Parameter (flag
 *    names). Rejects Variable, Other (HashtableAst/ConvertExpressionAst/
 *    BinaryExpressionAst all map to Other), ScriptBlock, SubExpression,
 *    ExpandableString. Same pattern as SAFE_PATH_ELEMENT_TYPES.
 * 2. Colon-bound parameter value — `-InputObject:$env:SECRET` creates a
 *    SINGLE CommandParameterAst; the VariableExpressionAst is its .Argument
 *    child, not a separate CommandElement. elementTypes = [..., 'Parameter'],
 *    whitelist passes. Query children[] for the .Argument's mapped type;
 *    anything other than StringConstant (Variable, ParenExpression wrapping
 *    arbitrary pipelines, Hashtable, etc.) is a leak vector.
 */
export declare function argLeaksValue(
  _cmd: string,
  element?: ParsedCommandElement,
): boolean
/**
 * Allowlist of PowerShell cmdlets that are considered read-only.
 * Each cmdlet maps to its configuration including safe flags.
 *
 * Note: PowerShell cmdlets are case-insensitive, so we store keys in lowercase
 * and normalize input for matching.
 *
 * Uses Object.create(null) to prevent prototype-chain pollution — attacker-
 * controlled command names like 'constructor' or '__proto__' must return
 * undefined, not inherited Object.prototype properties. Same defense as
 * COMMON_ALIASES in parser.ts.
 */
export declare const CMDLET_ALLOWLIST: Record<string, CommandConfig>
/**
 * Resolves a command name to its canonical cmdlet name using COMMON_ALIASES.
 * Strips Windows executable extensions (.exe, .cmd, .bat, .com) from path-free
 * names so e.g. `git.exe` canonicalises to `git` and triggers git-safety
 * guards (powershellPermissions.ts hasGitSubCommand). SECURITY: only strips
 * when the name has no path separator — `scripts\git.exe` is a relative path
 * (runs a local script, not PATH-resolved git) and must NOT canonicalise to
 * `git`. Returns lowercase canonical name.
 */
export declare function resolveToCanonical(name: string): string
/**
 * Checks if a command name (after alias resolution) alters the path-resolution
 * namespace for subsequent statements in the same compound command.
 *
 * Covers TWO classes:
 * 1. Cwd-changing cmdlets: Set-Location, Push-Location, Pop-Location (and
 *    aliases cd, sl, chdir, pushd, popd). Subsequent relative paths resolve
 *    from the new cwd.
 * 2. PSDrive-creating cmdlets: New-PSDrive (and aliases ndr, mount on Windows).
 *    Subsequent drive-prefixed paths (p:/foo) resolve via the new drive root,
 *    not via the filesystem. Finding #21: `New-PSDrive -Name p -Root /etc;
 *    Remove-Item p:/passwd` — the validator cannot know p: maps to /etc.
 *
 * Any compound containing one of these cannot have its later statements'
 * relative/drive-prefixed paths validated against the stale validator cwd.
 *
 * Name kept for BashTool parity (isCwdChangingCmdlet ↔ compoundCommandHasCd);
 * semantically this is "alters path-resolution namespace".
 */
export declare function isCwdChangingCmdlet(name: string): boolean
/**
 * Checks if a command name (after alias resolution) is a safe output cmdlet.
 */
export declare function isSafeOutputCommand(name: string): boolean
/**
 * Checks if a command element is a pipeline-tail transformer that was moved
 * from SAFE_OUTPUT_CMDLETS to CMDLET_ALLOWLIST (PIPELINE_TAIL_CMDLETS set)
 * AND passes its argLeaksValue guard via isAllowlistedCommand.
 *
 * Narrow fallback for isSafeOutputCommand call sites that need to keep the
 * "skip harmless pipeline tail" behavior for Format-Table / Select-Object / etc.
 * Does NOT match the full CMDLET_ALLOWLIST — only the migrated transformers.
 */
export declare function isAllowlistedPipelineTail(
  cmd: ParsedCommandElement,
  originalCommand: string,
): boolean
/**
 * Fail-closed gate for read-only auto-allow. Returns true ONLY for a
 * PipelineAst where every element is a CommandAst — the one statement
 * shape we can fully validate. Everything else (assignments, control
 * flow, expression sources, chain operators) defaults to false.
 *
 * Single code path to true. New AST types added to PowerShell fall
 * through to false by construction.
 */
export declare function isProvablySafeStatement(stmt: ParsedStatement): boolean
/**
 * Sync regex-based check for security-concerning patterns in a PowerShell command.
 * Used by isReadOnly (which must be sync) as a fast pre-filter before the
 * cmdlet allowlist check. This mirrors BashTool's checkReadOnlyConstraints
 * which checks bashCommandIsSafe_DEPRECATED before evaluating read-only status.
 *
 * Returns true if the command contains patterns that indicate it should NOT
 * be considered read-only, even if the cmdlet is in the allowlist.
 */
export declare function hasSyncSecurityConcerns(command: string): boolean
/**
 * Checks if a PowerShell command is read-only based on the cmdlet allowlist.
 *
 * @param command - The original PowerShell command string
 * @param parsed - The AST-parsed representation of the command
 * @returns true if the command is read-only, false otherwise
 */
export declare function isReadOnlyCommand(
  command: string,
  parsed?: ParsedPowerShellCommand,
): boolean
/**
 * Checks if a single command element is in the allowlist and passes flag validation.
 */
export declare function isAllowlistedCommand(
  cmd: ParsedCommandElement,
  originalCommand: string,
): boolean
export {}
