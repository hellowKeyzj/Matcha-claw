/**
 * Strip Unicode bidi overrides, zero-width chars, BOM, line/paragraph
 * separators, NEL, and ASCII control chars (except newline, CR, tab) from
 * user-stored memory content before placing it in tool_result.
 *
 * Memory content is data the user typed; it may contain prompt-injection
 * vectors (RTL overrides that flip apparent text, ANSI escapes, zero-width
 * characters that hide injected payloads).
 *
 * NOTE on regex construction: built via new RegExp(string) rather than
 * regex literals. Two reasons:
 *   (a) U+2028 and U+2029 are JS regex-literal terminators, so they
 *       cannot appear directly in a regex literal,
 *   (b) the escape sequences in a regex literal are TS-source-level,
 *       which can be corrupted by editor save round-trips on Windows.
 * Building from a string with explicit unicode escape sequences sidesteps
 * both problems.
 */
export declare function stripUntrustedControl(s: string): string
