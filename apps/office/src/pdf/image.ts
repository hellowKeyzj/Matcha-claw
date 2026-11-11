import sharp from 'sharp';

export async function decodePdfImage(base64: string): Promise<{ width: number; height: number; bgra: Buffer }> {
  const { data, info } = await sharp(Buffer.from(base64, 'base64'), { limitInputPixels: 48_000_000 }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index]!;
    data[index] = data[index + 2]!;
    data[index + 2] = red;
  }
  return { width: info.width, height: info.height, bgra: data };
}

export async function encodePdfBitmap(bgra: Buffer, width: number, height: number): Promise<Buffer> {
  const rgba = Buffer.from(bgra);
  for (let index = 0; index < rgba.length; index += 4) {
    const blue = rgba[index]!;
    rgba[index] = rgba[index + 2]!;
    rgba[index + 2] = blue;
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
