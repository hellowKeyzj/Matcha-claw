import type {
  ContentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { ToolPermissionContext } from 'src/Tool.js'
/**
 * Strips leading and trailing lines that contain only whitespace/newlines.
 * Unlike trim(), this preserves whitespace within content lines and only removes
 * completely empty lines from the beginning and end.
 */
export declare function stripEmptyLines(content: string): string
/**
 * Check if content is a base64 encoded image data URL
 */
export declare function isImageOutput(content: string): boolean
/**
 * Parse a data-URI string into its media type and base64 payload.
 * Input is trimmed before matching.
 */
export declare function parseDataUri(s: string): {
  mediaType: string
  data: string
} | null
/**
 * Build an image tool_result block from shell stdout containing a data URI.
 * Returns null if parse fails so callers can fall through to text handling.
 */
export declare function buildImageToolResult(
  stdout: string,
  toolUseID: string,
): ToolResultBlockParam | null
/**
 * Resize image output from a shell tool. stdout is capped at
 * getMaxOutputLength() when read back from the shell output file — if the
 * full output spilled to disk, re-read it from there, since truncated base64
 * would decode to a corrupt image that either throws here or gets rejected by
 * the API. Caps dimensions too: compressImageBuffer only checks byte size, so
 * a small-but-high-DPI PNG (e.g. matplotlib at dpi=300) sails through at full
 * resolution and poisons many-image requests (CC-304).
 *
 * Returns the re-encoded data URI on success, or null if the source didn't
 * parse as a data URI (caller decides whether to flip isImage).
 */
export declare function resizeShellImageOutput(
  stdout: string,
  outputFilePath: string | undefined,
  outputFileSize: number | undefined,
): Promise<string | null>
export declare function formatOutput(content: string): {
  totalLines: number
  truncatedContent: string
  isImage?: boolean
}
export declare const stdErrAppendShellResetMessage: (stderr: string) => string
export declare function resetCwdIfOutsideProject(
  toolPermissionContext: ToolPermissionContext,
): boolean
/**
 * Creates a human-readable summary of structured content blocks.
 * Used to display MCP results with images and text in the UI.
 */
export declare function createContentSummary(
  content: ContentBlockParam[],
): string
