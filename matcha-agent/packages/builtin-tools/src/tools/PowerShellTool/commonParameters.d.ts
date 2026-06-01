/**
 * PowerShell Common Parameters (available on all cmdlets via [CmdletBinding()]).
 * Source: about_CommonParameters (PowerShell docs) + Get-Command output.
 *
 * Shared between pathValidation.ts (merges into per-cmdlet known-param sets)
 * and readOnlyValidation.ts (merges into safeFlags check). Split out to break
 * what would otherwise be an import cycle between those two files.
 *
 * Stored lowercase with leading dash — callers `.toLowerCase()` their input.
 */
export declare const COMMON_SWITCHES: string[]
export declare const COMMON_VALUE_PARAMS: string[]
export declare const COMMON_PARAMETERS: ReadonlySet<string>
