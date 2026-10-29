/**
 * Registration-marker detection.
 *
 * The four corner markers are solid black squares. We binarise the image with a
 * local (adaptive) threshold so uneven lighting does not matter, label dark
 * connected components, keep the ones whose shape statistics match a solid
 * square under perspective, and then search for the four candidates that form
 * the most plausible sheet quadrilateral.
 */
import { FRAME_H, FRAME_W, MARKER_SIZE, type Point } from '../../../shared/sheet/layout';
import { boxMean, integral, type GrayImage } from './image';
import { dist, interiorAngles, isConvex, orderClockwise, polygonArea } from './geometry';

export interface MarkerCandidate extends Point {
  area: number;
  /** Equivalent square side length in pixels. */
  side: number;
  /** How well the blob matches a solid square (0–1). */
  squareness: number;
}

export interface MarkerQuad {
  /** Clockwise (screen) order starting near the image's top-left. */
  points: MarkerCandidate[];
  score: number;
}

export function detectMarkerCandidates(img: GrayImage): MarkerCandidate[] {
  const { width: w, height: h, data } = img;
  const minDim = Math.min(w, h);
  const sat = integral(img);
  const r = Math.max(15, Math.round(minDim / 12));

  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      const m = boxMean(sat, w, h, x, y, r);
      if (v < m * 0.72 && v < m - 18) mask[y * w + x] = 1;
    }
  }

  const minSide = Math.max(4, minDim * 0.008);
  const maxSide = minDim * 0.075;
  const minArea = minSide * minSide * 0.6;
  const maxArea = maxSide * maxSide * 1.3;

  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const pixels = new Int32Array(w * h);
  const out: MarkerCandidate[] = [];
  let label = 0;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    label++;
    let sp = 0;
    let n = 0;
    stack[sp++] = start;
    labels[start] = label;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % w;
      const py = (p - px) / w;
      pixels[n++] = p;
      sx += px;
      sy += py;
      sxx += px * px;
      syy += py * py;
      sxy += px * py;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      // 4-connectivity keeps thin diagonal bridges from merging blobs.
      if (px > 0 && mask[p - 1] && !labels[p - 1]) {
        labels[p - 1] = label;
        stack[sp++] = p - 1;
      }
      if (px < w - 1 && mask[p + 1] && !labels[p + 1]) {
        labels[p + 1] = label;
        stack[sp++] = p + 1;
      }
      if (py > 0 && mask[p - w] && !labels[p - w]) {
        labels[p - w] = label;
        stack[sp++] = p - w;
      }
      if (py < h - 1 && mask[p + w] && !labels[p + w]) {
        labels[p + w] = label;
        stack[sp++] = p + w;
      }
    }

    if (n < minArea || n > maxArea) continue;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const aspect = bw / bh;
    if (aspect < 0.45 || aspect > 2.2) continue;
    const fill = n / (bw * bh);
    if (fill < 0.45) continue;
    if (minX === 0 || minY === 0 || maxX === w - 1 || maxY === h - 1) continue; // clipped by frame edge

    const cx = sx / n;
    const cy = sy / n;
    const mxx = sxx / n - cx * cx;
    const myy = syy / n - cy * cy;
    const mxy = sxy / n - cx * cy;
    // Eigenvalues of the covariance matrix: a square (even skewed) is close to isotropic.
    const tr = mxx + myy;
    const disc = Math.sqrt(Math.max(0, ((mxx - myy) * (mxx - myy)) / 4 + mxy * mxy));
    const l1 = tr / 2 + disc;
    const l2 = tr / 2 - disc;
    if (l2 <= 0 || l2 / l1 < 0.35) continue;
    // Normalised inertia: a filled square gives 1/6, rings/hollow shapes much more.
    const inertia = tr / n;
    if (inertia < 0.13 || inertia > 0.24) continue;
    // Farthest pixel distance: squares reach their corners (≈0.5·A), circles only ≈0.32·A.
    let dmax = 0;
    for (let i = 0; i < n; i++) {
      const p = pixels[i];
      const px = p % w;
      const py = (p - px) / w;
      const d = (px - cx) * (px - cx) + (py - cy) * (py - cy);
      if (d > dmax) dmax = d;
    }
    // +0.707 px converts the farthest pixel centre into its outer corner.
    const reach = Math.sqrt(dmax) + Math.SQRT1_2;
    const cornerRatio = (reach * reach) / n;
    if (cornerRatio < 0.4 || cornerRatio > 0.9) continue;

    const squareness =
      Math.max(0, 1 - Math.abs(inertia - 1 / 6) * 10) * 0.4 +
      Math.max(0, 1 - Math.abs(cornerRatio - 0.5) * 3) * 0.3 +
      (l2 / l1) * 0.3;
    out.push({ x: cx + 0.5, y: cy + 0.5, area: n, side: Math.sqrt(n), squareness });
  }
  return out;
}

const FRAME_PERIMETER = 2 * (FRAME_W + FRAME_H);

/**
 * Ranks plausible marker quadrilaterals, best first. Multiple are returned so
 * the caller can fall back to the next candidate if the sheet code fails to
 * decode on the first.
 */
export function findMarkerQuads(cands: MarkerCandidate[], imgW: number, imgH: number, maxResults = 6): MarkerQuad[] {
  const pool = [...cands].sort((a, b) => b.area * b.squareness - a.area * a.squareness).slice(0, 26);
  const imgArea = imgW * imgH;
  const results: MarkerQuad[] = [];
  const n = pool.length;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        for (let d = c + 1; d < n; d++) {
          const quad = orderClockwise([pool[a], pool[b], pool[c], pool[d]]) as MarkerCandidate[];
          if (!isConvex(quad)) continue;
          const area = Math.abs(polygonArea(quad));
          if (area < imgArea * 0.04) continue;
          const angles = interiorAngles(quad);
          if (angles.some((t) => t < 35 || t > 145)) continue;
          const sides = quad.map((p) => p.side);
          const sMax = Math.max(...sides);
          const sMin = Math.min(...sides);
          if (sMax / sMin > 2.4) continue;
          const perimeter = quad.reduce((s, p, i) => s + dist(p, quad[(i + 1) % 4]), 0);
          const expectedSide = (perimeter / FRAME_PERIMETER) * MARKER_SIZE;
          const meanSide = sides.reduce((s, v) => s + v, 0) / 4;
          const ratio = meanSide / expectedSide;
          if (ratio < 0.5 || ratio > 1.8) continue;
          // Opposite edges should be roughly similar lengths (moderate perspective only).
          const e = quad.map((p, i) => dist(p, quad[(i + 1) % 4]));
          if (Math.max(e[0], e[2]) / Math.min(e[0], e[2]) > 2 || Math.max(e[1], e[3]) / Math.min(e[1], e[3]) > 2) continue;
          // Aspect: either orientation of the 180×250 frame is acceptable.
          const longSide = Math.max(e[0] + e[2], e[1] + e[3]);
          const shortSide = Math.min(e[0] + e[2], e[1] + e[3]);
          const aspect = longSide / shortSide;
          const target = FRAME_H / FRAME_W;
          if (aspect < target / 1.6 || aspect > target * 1.6) continue;
          const sizeConsistency = 1 - Math.min(1, Math.abs(Math.log(ratio)));
          const sq = quad.reduce((s, p) => s + p.squareness, 0) / 4;
          const score = (area / imgArea) * (0.5 + 0.5 * sizeConsistency) * (0.5 + 0.5 * sq) * (sMin / sMax);
          results.push({ points: quad, score });
        }
      }
    }
  }
  results.sort((x, y) => y.score - x.score);
  return results.slice(0, maxResults);
}
