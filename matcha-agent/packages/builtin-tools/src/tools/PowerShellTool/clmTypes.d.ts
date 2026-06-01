/**
 * PowerShell Constrained Language Mode allowed types.
 *
 * Microsoft's CLM restricts .NET type usage to this allowlist when PS runs
 * under AppLocker/WDAC system lockdown. Any type NOT in this set is considered
 * unsafe for untrusted code execution.
 *
 * We invert this: type literals not in this set → ask. One canonical check
 * replaces enumerating individual dangerous types (named pipes, reflection,
 * process spawning, P/Invoke marshaling, etc.). Microsoft maintains the list.
 *
 * Source: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_language_modes
 *
 * Normalization: entries stored lowercase, short AND full names where both
 * exist (PS resolves type accelerators like [int] → System.Int32 at runtime;
 * we match against what the AST emits, which is the literal text).
 */
export declare const CLM_ALLOWED_TYPES: ReadonlySet<string>
/**
 * Normalize a type name from AST TypeName.FullName or TypeName.Name.
 * Handles array suffix ([]) and generic brackets.
 */
export declare function normalizeTypeName(name: string): string
/**
 * True if typeName (from AST) is in Microsoft's CLM allowlist.
 * Types NOT in this set trigger ask — they access system APIs CLM blocks.
 */
export declare function isClmAllowedType(typeName: string): boolean
