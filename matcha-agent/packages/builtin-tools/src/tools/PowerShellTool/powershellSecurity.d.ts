/**
 * PowerShell-specific security analysis for command validation.
 *
 * Detects dangerous patterns: code injection, download cradles, privilege
 * escalation, dynamic command names, COM objects, etc.
 *
 * All checks are AST-based. If parsing failed (valid=false), none of the
 * individual checks match and powershellCommandIsSafe returns 'ask'.
 */
import type { ParsedPowerShellCommand } from 'src/utils/powershell/parser.js'
type PowerShellSecurityResult = {
  behavior: 'passthrough' | 'ask' | 'allow'
  message?: string
}
/**
 * Main entry point for PowerShell security validation.
 * Checks a PowerShell command against known dangerous patterns.
 *
 * All checks are AST-based. If the AST parse failed (parsed.valid === false),
 * none of the individual checks will match and we return 'ask' as a safe default.
 *
 * @param command - The PowerShell command to validate (unused, kept for API compat)
 * @param parsed - Parsed AST from PowerShell's native parser (required)
 * @returns Security result indicating whether the command is safe
 */
export declare function powershellCommandIsSafe(
  _command: string,
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult
export {}
