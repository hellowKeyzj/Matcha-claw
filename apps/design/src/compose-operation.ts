import type { DesignDocument, GenerationRequest, ImageLayer } from './document';

type ComposeAttachment = {
  assetId: string;
  attachmentName: string;
  attachmentIndex: number;
  isPreview: boolean;
  originalMimeType: string;
};

export interface DesignComposeOperation {
  toolName: string;
  instructions: string;
  document: Pick<DesignDocument, 'id' | 'revision' | 'sessionIdentity'>;
  summary: { name: string; imageCountNames: string[] };
  sources: (ComposeAttachment & { layerId: string; name: string; crop?: ImageLayer['crop'] })[];
  references?: ComposeAttachment[];
  model?: ComposeAttachment;
  logo?: ComposeAttachment;
  annotation?: ComposeAttachment;
  requests: GenerationRequest[];
}
