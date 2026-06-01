export declare const REPL_TOOL_NAME = 'REPL'
/**
 * REPL mode is default-on for ants in the interactive CLI (opt out with
 * CLAUDE_CODE_REPL=0). The legacy CLAUDE_REPL_MODE=1 also forces it on.
 *
 * SDK entrypoints (sdk-ts, sdk-py, sdk-cli) are NOT defaulted on — SDK
 * consumers script direct tool calls (Bash, Read, etc.) and REPL mode
 * hides those tools. USER_TYPE is a build-time --define, so the ant-native
 * binary would otherwise force REPL mode on every SDK subprocess regardless
 * of the env the caller passes.
 */
export declare function isReplModeEnabled(): boolean
/**
 * Tools that are only accessible via REPL when REPL mode is enabled.
 * When REPL mode is on, these tools are hidden from Claude's direct use,
 * forcing Claude to use REPL for batch operations.
 */
export declare const REPL_ONLY_TOOLS: Set<string>
