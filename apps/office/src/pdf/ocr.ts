import { join } from 'node:path';
import { createVisionOcrEngine, createWindowsOcrEngine } from '../../genoffice/packages/pdf2docx/src/ocr-vision';
import type { OcrEngine } from '../../genoffice/packages/pdf2docx/src/ocr';

let engine: OcrEngine | null | undefined;
let resourcesPath = '';
export function configurePdfOcr(packagePath: string): void { resourcesPath = packagePath; engine = undefined; }
export function getPdfOcrEngine(): OcrEngine | null {
  if (engine !== undefined) return engine;
  const create = process.platform === 'darwin' ? createVisionOcrEngine : createWindowsOcrEngine;
  const helper = process.platform === 'darwin' ? 'vision-ocr' : 'win-ocr.exe';
  engine = create(join(resourcesPath, 'native', 'ocr', helper));
  return engine;
}
