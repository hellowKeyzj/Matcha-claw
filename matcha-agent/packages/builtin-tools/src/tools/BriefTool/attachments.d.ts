/**
 * Shared attachment validation + resolution for SendUserMessage and
 * SendUserFile. Lives in BriefTool/ so the dynamic `./upload.js` import
 * inside the feature('BRIDGE_MODE') guard stays relative and upload.ts
 * (axios, crypto, auth utils) remains tree-shakeable from non-bridge builds.
 */
import type { ValidationResult } from 'src/Tool.js'
export type ResolvedAttachment = {
  path: string
  size: number
  isImage: boolean
  file_uuid?: string
}
export declare function validateAttachmentPaths(
  rawPaths: string[],
): Promise<ValidationResult>
export declare function resolveAttachments(
  rawPaths: string[],
  uploadCtx: {
    replBridgeEnabled: boolean
    signal?: AbortSignal
  },
): Promise<ResolvedAttachment[]>
