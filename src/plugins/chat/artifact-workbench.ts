import type { GeneratedFile } from '@/plugins/files/generated-files';
import type { ChatArtifactGroup } from '@/plugins/chat/artifacts';

export function resolveArtifactGroupFocusFile(
  artifactGroup: ChatArtifactGroup | null | undefined,
  preferredFilePath?: string | null,
): GeneratedFile | null {
  if (!artifactGroup || artifactGroup.files.length === 0) {
    return null;
  }
  if (preferredFilePath) {
    const matchedFile = artifactGroup.files.find((file) => file.filePath === preferredFilePath);
    if (matchedFile) {
      return matchedFile;
    }
  }
  return artifactGroup.files[artifactGroup.files.length - 1] ?? null;
}
