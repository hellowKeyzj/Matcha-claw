import type { Buffer } from 'buffer'
export type SharpInstance = {
  metadata(): Promise<{
    width: number
    height: number
    format: string
  }>
  resize(
    width: number,
    height: number,
    options?: {
      fit?: string
      withoutEnlargement?: boolean
    },
  ): SharpInstance
  jpeg(options?: { quality?: number }): SharpInstance
  png(options?: {
    compressionLevel?: number
    palette?: boolean
    colors?: number
  }): SharpInstance
  webp(options?: { quality?: number }): SharpInstance
  toBuffer(): Promise<Buffer>
}
export type SharpFunction = (input: Buffer) => SharpInstance
type SharpCreatorOptions = {
  create: {
    width: number
    height: number
    channels: 3 | 4
    background: {
      r: number
      g: number
      b: number
    }
  }
}
type SharpCreator = (options: SharpCreatorOptions) => SharpInstance
export declare function getImageProcessor(): Promise<SharpFunction>
/**
 * Get image creator for generating new images from scratch.
 * Note: image-processor-napi doesn't support image creation,
 * so this always uses sharp directly.
 */
export declare function getImageCreator(): Promise<SharpCreator>
export {}
