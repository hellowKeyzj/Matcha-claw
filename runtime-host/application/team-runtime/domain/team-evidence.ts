export type TeamEvidenceRef =
  | TeamWorkspacePathEvidenceRef
  | TeamUriEvidenceRef
  | TeamArtifactEvidenceRef
  | TeamInlineTextEvidenceRef;

export interface TeamWorkspacePathEvidenceRef {
  readonly type: 'workspacePath';
  readonly path: string;
  readonly label?: string;
}

export interface TeamUriEvidenceRef {
  readonly type: 'uri';
  readonly uri: string;
  readonly label?: string;
}

export interface TeamArtifactEvidenceRef {
  readonly type: 'artifact';
  readonly artifactId: string;
  readonly label?: string;
}

export interface TeamInlineTextEvidenceRef {
  readonly type: 'inlineText';
  readonly text: string;
  readonly label?: string;
}
