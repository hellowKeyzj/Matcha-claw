import type { ImageLayer } from './document';

type Adjustments = NonNullable<ImageLayer['adjustments']>;

function blurPixels({ data, width, height }: ImageData, radius: number): void {
  const temporary = new Uint8ClampedArray(data.length);
  // Reference GPU semantics: two premultiplied triangular passes, without random subpixel jitter.
  const taps = Array.from({ length: 31 }, (_, index) => {
    const position = (index - 15) / 15;
    return { offset: position * radius, weight: 1 - Math.abs(position) };
  }).filter(({ weight }) => weight > 0);
  const total = taps.reduce((sum, { weight }) => sum + weight, 0);
  for (const horizontal of [true, false]) {
    const source = horizontal ? data : temporary;
    const target = horizontal ? temporary : data;
    const length = horizontal ? width : height;
    const lines = horizontal ? height : width;
    const stride = horizontal ? 4 : width * 4;
    for (let position = 0; position < length; position++) {
      const samples = taps.map(({ offset, weight }) => {
        const coordinate = position + offset;
        const lower = Math.floor(coordinate), upper = lower + 1;
        return { lower: lower >= 0 && lower < length ? lower * stride : -1,
          upper: upper >= 0 && upper < length ? upper * stride : -1,
          fraction: coordinate - lower, weight };
      });
      for (let line = 0; line < lines; line++) {
        const base = horizontal ? line * width * 4 : line * 4;
        let red = 0, green = 0, blue = 0, alpha = 0;
        for (const { lower, upper, fraction, weight } of samples) {
          const first = base + lower;
          const second = base + upper;
          const firstAlpha = lower < 0 ? 0 : source[first + 3] * (1 - fraction) * weight;
          const secondAlpha = upper < 0 ? 0 : source[second + 3] * fraction * weight;
          if (firstAlpha) {
            red += source[first] * firstAlpha;
            green += source[first + 1] * firstAlpha;
            blue += source[first + 2] * firstAlpha;
          }
          if (secondAlpha) {
            red += source[second] * secondAlpha;
            green += source[second + 1] * secondAlpha;
            blue += source[second + 2] * secondAlpha;
          }
          alpha += firstAlpha + secondAlpha;
        }
        const index = base + position * stride;
        target[index] = alpha > 0 ? red / alpha : 0;
        target[index + 1] = alpha > 0 ? green / alpha : 0;
        target[index + 2] = alpha > 0 ? blue / alpha : 0;
        target[index + 3] = alpha / total;
      }
    }
  }
}

export function applyImageAdjustments(image: ImageData, adjustments: Adjustments, blurRadius: number): void {
  if (blurRadius) blurPixels(image, blurRadius);
  const { data } = image;
  const brightness = Math.round(255 * adjustments.brightness / 100);
  const contrast = Math.floor(255 * adjustments.contrast / 100);
  const factor = 259 * (contrast + 255) / (255 * (259 - contrast));
  const angle = adjustments.hue * Math.PI / 100;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle) / Math.sqrt(3);
  const saturation = adjustments.saturation / 100;
  for (let index = 0; index < data.length; index += 4) {
    // Each stage clamps to bytes before the next, as in the reference 2D color filters.
    for (let channel = 0; channel < 3; channel++) {
      if (brightness) data[index + channel] += brightness;
      if (adjustments.contrast) data[index + channel] = factor * (data[index + channel] - 128) + 128;
    }
    if (adjustments.hue) {
      const red = data[index], green = data[index + 1], blue = data[index + 2];
      const gray = (red + green + blue) / 3 * (1 - cosine);
      data[index] = red * cosine + gray + (blue - green) * sine;
      data[index + 1] = green * cosine + gray + (red - blue) * sine;
      data[index + 2] = blue * cosine + gray + (green - red) * sine;
    }
    if (saturation) {
      const maximum = Math.max(data[index], data[index + 1], data[index + 2]);
      for (let channel = 0; channel < 3; channel++) data[index + channel] += (data[index + channel] - maximum) * saturation;
    }
    if (adjustments.invert) for (let channel = 0; channel < 3; channel++) data[index + channel] = 255 - data[index + channel];
  }
}
