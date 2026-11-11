import type { AppToolResult } from '@matcha/app-plugins-sdk';
import type { DocumentRecord } from './model';

export const LIBRARY_SCHEME = 'matcha-office://';

export function libraryPath(record: { id: string; name: string }): string {
  return `${LIBRARY_SCHEME}${record.id}/${encodeURIComponent(record.name)}`;
}

export function libraryId(path: string): string | null {
  if (!path.startsWith(LIBRARY_SCHEME)) return null;
  const rest = path.slice(LIBRARY_SCHEME.length);
  const id = rest.split('/')[0] ?? '';
  return /^doc_[a-f0-9]{16}$/.test(id) ? id : null;
}

export function appApi() {
  const value = window.matchaApp;
  if (!value) throw new Error('Matcha Office must run inside the MatchaClaw app frame.');
  return value;
}

export async function callTool<T>(name: string, input: Record<string, unknown> = {}): Promise<T> {
  const response: AppToolResult = await appApi().call(name, input);
  if (response.isError) {
    const text = response.content?.find((item) => item.type === 'text')?.text;
    const message = typeof text === 'string' && text ? text : `Matcha Office tool ${name} failed.`;
    const detail = response.structuredContent as { code?: string; currentRevision?: number } | undefined;
    throw Object.assign(new Error(message), {
      code: detail?.code,
      currentRevision: detail?.currentRevision,
      detail
    });
  }
  return response.structuredContent as T;
}

export async function listDocuments(type?: DocumentRecord['type']): Promise<readonly DocumentRecord[]> {
  const { documents } = await callTool<{ documents: readonly DocumentRecord[] }>('documents_list');
  return type ? documents.filter((document) => document.type === type) : documents;
}

export async function readDocumentBytes(id: string): Promise<{ record: DocumentRecord; bytes: Uint8Array }> {
  const exported = await callTool<{
    document: DocumentRecord;
    name: string;
    mimeType: string;
    data: string;
  }>('document_export', { documentId: id, format: 'original' });
  return { record: { ...exported.document, mimeType: exported.mimeType }, bytes: base64ToBytes(exported.data) };
}

export async function writeDocumentBytes(id: string, expectedRevision: number, bytes: Uint8Array): Promise<DocumentRecord> {
  const { document } = await callTool<{ document: DocumentRecord }>('document_write', {
    documentId: id,
    expectedRevision,
    data: bytesToBase64(bytes)
  });
  return document;
}

export async function importDocument(name: string, mimeType: string, bytes: Uint8Array): Promise<DocumentRecord> {
  const { document } = await callTool<{ document: DocumentRecord }>('document_import', {
    name,
    mimeType,
    data: bytesToBase64(bytes)
  });
  return document;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
