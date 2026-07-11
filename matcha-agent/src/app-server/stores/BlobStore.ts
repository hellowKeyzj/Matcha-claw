import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BlobRef } from '../protocol/types.js'
import { sessionStorageDirectoryName } from './sessionStoragePath.js'

const DEFAULT_TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8'
const DEFAULT_JSON_CONTENT_TYPE = 'application/json; charset=utf-8'
const DEFAULT_BINARY_CONTENT_TYPE = 'application/octet-stream'
const PREVIEW_LIMIT = 160

export class BlobStore {
  private readonly storageRoot: string

  constructor(options: { storageRoot: string }) {
    this.storageRoot = options.storageRoot
  }

  writeText(
    sessionId: string,
    text: string,
    contentType = DEFAULT_TEXT_CONTENT_TYPE,
  ): Promise<BlobRef> {
    return this.writeBytes(
      sessionId,
      Buffer.from(text, 'utf8'),
      contentType,
      buildTextPreview(text),
    )
  }

  writeJson(
    sessionId: string,
    value: unknown,
    contentType = DEFAULT_JSON_CONTENT_TYPE,
  ): Promise<BlobRef> {
    const text = JSON.stringify(value)
    if (text === undefined) {
      throw new TypeError(
        'BlobStore.writeJson requires a JSON-serializable value',
      )
    }
    return this.writeBytes(
      sessionId,
      Buffer.from(text, 'utf8'),
      contentType,
      buildTextPreview(text),
    )
  }

  writeBuffer(
    sessionId: string,
    buffer: Uint8Array,
    contentType = DEFAULT_BINARY_CONTENT_TYPE,
  ): Promise<BlobRef> {
    return this.writeBytes(sessionId, buffer, contentType)
  }

  async read(
    sessionId: string,
    blobId: string,
  ): Promise<Uint8Array | undefined> {
    try {
      return await readFile(this.blobPath(sessionId, blobId))
    } catch (error) {
      if (isNotFoundError(error)) return undefined
      throw error
    }
  }

  private async writeBytes(
    sessionId: string,
    bytes: Uint8Array,
    contentType: string,
    preview?: string,
  ): Promise<BlobRef> {
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const blobId = sha256
    const blobPath = this.blobPath(sessionId, blobId)

    await mkdir(this.blobsDirectory(sessionId), { recursive: true })
    try {
      await writeFile(blobPath, bytes, { flag: 'wx' })
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error
    }

    return {
      blobId,
      byteLength: bytes.byteLength,
      contentType,
      sha256,
      ...(preview !== undefined ? { preview } : {}),
    }
  }

  private blobsDirectory(sessionId: string): string {
    return join(
      this.storageRoot,
      'sessions',
      sessionStorageDirectoryName(sessionId),
      'blobs',
    )
  }

  private blobPath(sessionId: string, blobId: string): string {
    return join(this.blobsDirectory(sessionId), blobId)
  }
}

function buildTextPreview(text: string): string {
  if (text.length <= PREVIEW_LIMIT) return text
  return `${text.slice(0, PREVIEW_LIMIT)}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function isAlreadyExistsError(error: unknown): boolean {
  return isRecord(error) && error.code === 'EEXIST'
}
