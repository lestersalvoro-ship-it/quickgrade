/** Minimal grayscale image toolkit used by the scanner (no native CV dependency). */

export interface GrayImage {
  width: number;
  height: number;
  /** Row-major intensities, 0 (black) – 255 (white). */
  data: Float32Array;
}

export function createImage(width: number, height: number, fill = 0): GrayImage {
  const data = new Float32Array(width * height);
  if (fill) data.fill(fill);
  return { width, height, data };
}

export function fromUint8(width: number, height: number, src: Uint8Array | Buffer, channels = 1): GrayImage {
  const img = createImage(width, height);
  if (channels === 1) {
    for (let i = 0; i < img.data.length; i++) img.data[i] = src[i];
  } else {
    for (let i = 0; i < img.data.length; i++) img.data[i] = src[i * channels];
  }
  return img;
}

export function toUint8(img: GrayImage): Buffer {
  const out = Buffer.alloc(img.width * img.height);
  for (let i = 0; i < out.length; i++) {
    const v = img.data[i];
    out[i] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
  }
  return out;
}

/** Bilinear sample with edge clamping. */
export function sample(img: GrayImage, x: number, y: number): number {
  const { width: w, height: h, data } = img;
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const r0 = y0 * w;
  const r1 = y1 * w;
  const a = data[r0 + x0] + (data[r0 + x1] - data[r0 + x0]) * fx;
  const b = data[r1 + x0] + (data[r1 + x1] - data[r1 + x0]) * fx;
  return a + (b - a) * fy;
}

/** Area-average downscale by an integer factor. */
export function downscale(img: GrayImage, factor: number): GrayImage {
  if (factor <= 1) return img;
  const w = Math.floor(img.width / factor);
  const h = Math.floor(img.height / factor);
  const out = createImage(w, h);
  const inv = 1 / (factor * factor);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * img.width + x * factor;
        for (let dx = 0; dx < factor; dx++) s += img.data[row + dx];
      }
      out.data[y * w + x] = s * inv;
    }
  }
  return out;
}

/** Summed-area table with one row/column of zero padding. */
export function integral(img: GrayImage): Float64Array {
  const w = img.width + 1;
  const sat = new Float64Array(w * (img.height + 1));
  for (let y = 0; y < img.height; y++) {
    let rowSum = 0;
    for (let x = 0; x < img.width; x++) {
      rowSum += img.data[y * img.width + x];
      sat[(y + 1) * w + x + 1] = sat[y * w + x + 1] + rowSum;
    }
  }
  return sat;
}

export function boxMean(sat: Float64Array, imgW: number, imgH: number, x: number, y: number, r: number): number {
  const x0 = Math.max(0, x - r);
  const y0 = Math.max(0, y - r);
  const x1 = Math.min(imgW, x + r + 1);
  const y1 = Math.min(imgH, y + r + 1);
  const w = imgW + 1;
  const s = sat[y1 * w + x1] - sat[y0 * w + x1] - sat[y1 * w + x0] + sat[y0 * w + x0];
  return s / ((x1 - x0) * (y1 - y0));
}

export function meanAndStd(img: GrayImage): { mean: number; std: number } {
  let s = 0;
  let s2 = 0;
  const n = img.data.length;
  for (let i = 0; i < n; i++) {
    const v = img.data[i];
    s += v;
    s2 += v * v;
  }
  const mean = s / n;
  return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
}
