/**
 * Upload BriefTool attachments to private_api so web viewers can preview them.
 *
 * When the repl bridge is active, attachment paths are meaningless to a web
 * viewer (they're on Claude's machine). We upload to /api/oauth/file_upload —
 * the same store MessageComposer/SpaceMessage render from — and stash the
 * returned file_uuid alongside the path. Web resolves file_uuid → preview;
 * desktop/local try path first.
 *
 * Best-effort: any failure (no token, bridge off, network error, 4xx) logs
 * debug and returns undefined. The attachment still carries {path, size,
 * isImage}, so local-terminal and same-machine-desktop render unaffected.
 */
export type BriefUploadContext = {
  replBridgeEnabled: boolean
  signal?: AbortSignal
}
/**
 * Upload a single attachment. Returns file_uuid on success, undefined otherwise.
 * Every early-return is intentional graceful degradation.
 */
export declare function uploadBriefAttachment(
  fullPath: string,
  size: number,
  ctx: BriefUploadContext,
): Promise<string | undefined>
