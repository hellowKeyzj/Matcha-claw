import type { DocsReadProjection } from '../docs/projection';

export type DocumentType = 'docx' | 'xlsx' | 'csv' | 'pptx' | 'pdf' | 'md' | 'html' | 'txt' | 'json';

export interface DocumentRecord {
  readonly id: string;
  readonly name: string;
  readonly type: DocumentType;
  readonly mimeType: string;
  readonly size: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  /** Optional library-relative virtual path, never a physical storage path. */
  readonly libraryPath?: string;
  readonly autoNamePending?: true;
}

export interface DocumentResource {
  readonly path: string;
  readonly bytes: Uint8Array;
  /** Internal hash of the original generated resource bytes; absent after a public replacement. */
  readonly ownedSha256?: string;
}

export type DocumentContent = Uint8Array | ({ readonly bytes: Uint8Array } | { readonly filePath: string }) & {
  readonly resources?: readonly DocumentResource[];
  /** Backend-only original file location for resolving native relative references. */
  readonly sourcePath?: string;
};

export interface DocumentSnapshot {
  readonly record: DocumentRecord;
  readonly path: string;
  release(): Promise<void>;
}

export interface EditorDocumentHooks {
  saveDocument(id: string, expectedRevision: number, produce: () => Promise<DocumentContent>, signal?: AbortSignal): Promise<number>;
  createDocument(name: string, produce: () => Promise<DocumentContent>, signal?: AbortSignal, libraryPath?: string, type?: 'csv'): Promise<{ documentId: string; revision: number; name: string }>;
  moveDocument(id: string, expectedRevision: number, libraryPath: string, signal?: AbortSignal): Promise<DocumentRecord>;
  autoNameDocument(id: string, expectedRevision: number, baseName: string): Promise<DocumentRecord | null>;
  readSnapshot(id: string, signal?: AbortSignal): Promise<DocumentSnapshot>;
  readDocument(id: string): Promise<{ record: DocumentRecord; bytes: Uint8Array; resources: readonly DocumentResource[]; sourcePath?: string }>;
  listDocuments(): Promise<readonly DocumentRecord[]>;
  listResources(id: string): Promise<readonly { path: string; size: number; readonly ownedSha256?: string }[]>;
  readResource(id: string, path: string): Promise<Uint8Array>;
  putResource(id: string, expectedRevision: number, path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<{ revision: number; path: string }>;
  /** Virtual library identity; never a native filesystem path. */
  logicalPath(record: Pick<DocumentRecord, 'id' | 'name' | 'libraryPath'>): string;
}

export interface DocumentIndex {
  readonly version: 1;
  readonly documents: readonly DocumentRecord[];
}

export interface DocumentPreview extends Partial<DocsReadProjection> {
  readonly kind: 'docs' | 'sheets' | 'slides' | 'pdf' | 'text';
  readonly html?: string;
  readonly blocks?: number;
  readonly items?: readonly unknown[];
  readonly rows?: readonly (readonly (string | number | boolean | null)[])[];
  readonly formulas?: Readonly<Record<string, string>>;
  readonly sheet?: string;
  readonly range?: string;
  readonly features?: Readonly<Record<string, unknown>>;
  readonly size?: { readonly cx: number; readonly cy: number };
  readonly slides?: readonly unknown[];
  readonly pages?: readonly unknown[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly text?: string;
  readonly truncated?: boolean;
}
