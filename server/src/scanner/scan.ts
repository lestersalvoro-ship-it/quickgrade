/**
 * QuickGrade answer-sheet scanner.
 *
 * Pipeline: decode → quality checks → corner-marker detection → for each
 * plausible marker quad and orientation, read the sheet code (CRC-protected) →
 * perspective-warp the sheet into canonical millimetre space → flatten
 * illumination → align bubble rows locally (paper curl, lens distortion) →
 * measure fills → classify with per-sheet calibration → flag anything uncertain.
 */
import sharp from 'sharp';
import {
  BUBBLE_R,
  CODE_BITS,
  FRAME_H,
  FRAME_W,
  ID_BUBBLE_R,
  MAX_CHOICES,
  MAX_QUESTIONS,
  computeSheetLayout,
  type Bubble,
  type Point,
  type SheetLayout,
} from '../../../shared/sheet/layout';
import { decodeSheetCode } from '../../../shared/sheet/code';
import type {
  DetectedAnswer,
  DetectedStudentId,
  ScanError,
  ScanErrorCode,
  ScanResult,
  ScanSuccess,
} from '../../../shared/scan-types';
import { createImage, downscale, fromUint8, meanAndStd, sample, toUint8, type GrayImage } from './image';
import { applyH, homographyFrom4, type Homography } from './geometry';
import { detectMarkerCandidates, findMarkerQuads, type MarkerQuad } from './markers';
import { calibrate, classifyBubbles, relativeFills } from './classify';

export interface ExpectedLayout {
  questionCount: number;
  choiceCount: number;
  quizCode?: number;
}

export interface ScanOptions {
  /** Layout of the quiz the teacher selected; enables a fallback when the code strip is damaged. */
  expected?: ExpectedLayout;
  /** Produce a JPEG of the rectified sheet for the review screen. */
  rectifiedImage?: boolean;
}

export interface ScanOutput {
  result: ScanResult;
  rectifiedJpeg?: Buffer;
}

const MAX_DECODE_SIDE = 2400;
const PX_PER_MM = 6;
const MARGIN_MM = 6;

const ERROR_TEXT: Record<ScanErrorCode, { message: string; hint: string }> = {
  IMAGE_UNREADABLE: { message: 'The file could not be read as an image.', hint: 'Upload a JPEG, PNG or WebP photo of the answer sheet.' },
  RESOLUTION_TOO_LOW: { message: 'The photo resolution is too low to read the bubbles.', hint: 'Use the camera at full resolution, at least 1000 pixels on the short side.' },
  TOO_DARK: { message: 'The photo is too dark.', hint: 'Move to a brighter area or turn on more lights. Avoid shadows over the sheet.' },
  OVEREXPOSED: { message: 'The photo is overexposed or blank.', hint: 'Avoid direct glare and flash reflections; make sure the sheet is in view.' },
  MARKERS_NOT_FOUND: {
    message: 'Could not find the four black corner squares.',
    hint: 'Fit the whole sheet in the frame with all four corner squares visible, hold the camera parallel to the page and keep the sheet flat.',
  },
  SHEET_CODE_UNREADABLE: {
    message: 'The sheet code strip at the top could not be read.',
    hint: 'Make sure the strip of small black squares at the top is not covered, folded or written on. Select the quiz before scanning to allow a fallback.',
  },
  TOO_BLURRY: { message: 'The photo is too blurry to read the bubbles reliably.', hint: 'Hold the camera steady, tap to focus on the sheet and retake the photo.' },
  LAYOUT_UNSUPPORTED: { message: 'This sheet uses a layout this version of QuickGrade cannot read.', hint: 'Print a fresh answer sheet from QuickGrade for this quiz.' },
};

function fail(code: ScanErrorCode, warnings: string[] = []): ScanOutput {
  const error: ScanError = { code, ...ERROR_TEXT[code] };
  return { result: { ok: false, error, warnings } };
}

// ---------------------------------------------------------------------------
// Sampling helpers

/** Points on a circle, precomputed per radius. */
function circlePoints(r: number, n = 16): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push({ x: Math.cos(t) * r, y: Math.sin(t) * r });
  }
  return pts;
}

function diskOffsets(r: number): Point[] {
  const pts: Point[] = [];
  const ri = Math.ceil(r);
  for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) if (dx * dx + dy * dy <= r * r) pts.push({ x: dx, y: dy });
  return pts;
}

interface Canvas {
  dark: GrayImage; // 0 = white, 1 = black (stored in data as 0..1)
  s: number; // px per mm
  margin: number;
}

const toPx = (c: Canvas, p: Point): Point => ({ x: (p.x + c.margin) * c.s, y: (p.y + c.margin) * c.s });

function meanAt(img: GrayImage, cx: number, cy: number, pts: Point[]): number {
  let sum = 0;
  for (const p of pts) sum += sample(img, cx + p.x, cy + p.y);
  return sum / pts.length;
}

// ---------------------------------------------------------------------------
// Geometry → canonical sheet

function warpFrame(src: GrayImage, h: Homography, s: number, margin: number): GrayImage {
  const w = Math.round((FRAME_W + 2 * margin) * s);
  const hgt = Math.round((FRAME_H + 2 * margin) * s);
  const out = createImage(w, hgt);
  for (let j = 0; j < hgt; j++) {
    const y = j / s - margin;
    for (let i = 0; i < w; i++) {
      const p = applyH(h, i / s - margin, y);
      out.data[j * w + i] = sample(src, p.x, p.y);
    }
  }
  return out;
}

/**
 * Flat-field correction: estimates the local paper brightness with a robust
 * block statistic (90th percentile) and divides it out. Returns darkness 0–1.
 */
function normalizeIllumination(img: GrayImage, blockPx: number): GrayImage {
  const { width: w, height: h, data } = img;
  const bw = Math.ceil(w / blockPx);
  const bh = Math.ceil(h / blockPx);
  const blocks = new Float32Array(bw * bh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      hist.fill(0);
      let n = 0;
      const y1 = Math.min(h, (by + 1) * blockPx);
      const x1 = Math.min(w, (bx + 1) * blockPx);
      for (let y = by * blockPx; y < y1; y++) {
        for (let x = bx * blockPx; x < x1; x++) {
          const v = data[y * w + x];
          hist[v <= 0 ? 0 : v >= 255 ? 255 : v | 0]++;
          n++;
        }
      }
      const target = n * 0.9;
      let acc = 0;
      let k = 0;
      for (; k < 255; k++) {
        acc += hist[k];
        if (acc >= target) break;
      }
      blocks[by * bw + bx] = Math.max(k, 8);
    }
  }
  // Replace blocks that are far darker than their neighbourhood (solid print such as markers).
  const fixed = new Float32Array(blocks);
  const neigh: number[] = [];
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      neigh.length = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = bx + dx;
          const y = by + dy;
          if (x >= 0 && y >= 0 && x < bw && y < bh) neigh.push(blocks[y * bw + x]);
        }
      neigh.sort((a, b) => a - b);
      const med = neigh[neigh.length >> 1];
      if (blocks[by * bw + bx] < med * 0.8) fixed[by * bw + bx] = med;
    }
  }
  // 3×3 smoothing.
  const smooth = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = bx + dx;
          const y = by + dy;
          if (x >= 0 && y >= 0 && x < bw && y < bh) {
            s += fixed[y * bw + x];
            n++;
          }
        }
      smooth[by * bw + bx] = s / n;
    }
  }
  const bg: GrayImage = { width: bw, height: bh, data: smooth };
  const out = createImage(w, h);
  for (let y = 0; y < h; y++) {
    const by = (y + 0.5) / blockPx - 0.5;
    for (let x = 0; x < w; x++) {
      const b = sample(bg, (x + 0.5) / blockPx - 0.5, by);
      const v = data[y * w + x] / b;
      out.data[y * w + x] = v >= 1 ? 0 : v <= 0 ? 1 : 1 - v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sheet code

interface CodeRead {
  bits: number[];
  darkness: number[];
  uncertainCells: number;
}

/** Reads the code strip directly from the source photo using local white references. */
function readCode(src: GrayImage, h: Homography, layout: SheetLayout): CodeRead {
  const bits: number[] = [];
  const darkness: number[] = [];
  let uncertain = 0;
  for (let i = 0; i < CODE_BITS; i++) {
    const cell = layout.codeCells[i];
    const ref = layout.codeWhiteRefs[i];
    let inner = 0;
    let n = 0;
    const half = cell.size * 0.28;
    for (let gy = -2; gy <= 2; gy++)
      for (let gx = -2; gx <= 2; gx++) {
        const p = applyH(h, cell.x + (gx / 2) * half, cell.y + (gy / 2) * half);
        inner += sample(src, p.x, p.y);
        n++;
      }
    inner /= n;
    let white = 0;
    let m = 0;
    for (let gy = -1; gy <= 1; gy++)
      for (let gx = -1; gx <= 1; gx++) {
        const p = applyH(h, ref.x + gx * 0.8, ref.y + gy * 0.5);
        white += sample(src, p.x, p.y);
        m++;
      }
    white /= m;
    const d = white > 1 ? Math.max(0, Math.min(1, 1 - inner / white)) : 0;
    darkness.push(d);
    bits.push(d > 0.42 ? 1 : 0);
    if (d > 0.25 && d < 0.6) uncertain++;
  }
  return { bits, darkness, uncertainCells: uncertain };
}

// Any 4-corner cyclic assignment maps the quad's points onto frame markers TL, TR, BR, BL.
const FRAME_CORNERS: Point[] = [
  { x: 0, y: 0 },
  { x: FRAME_W, y: 0 },
  { x: FRAME_W, y: FRAME_H },
  { x: 0, y: FRAME_H },
];

function homographyFor(quad: MarkerQuad, rotation: number, scaleUp: number): Homography | null {
  const img = [0, 1, 2, 3].map((i) => {
    const p = quad.points[(i + rotation) % 4];
    return { x: p.x * scaleUp - 0.5, y: p.y * scaleUp - 0.5 };
  });
  return homographyFrom4(FRAME_CORNERS, img);
}

/** Orientation of the sheet as seen in the photo, from where its top-left corner landed. */
function orientationOf(h: Homography): 0 | 90 | 180 | 270 {
  const o = applyH(h, 0, 0);
  const x = applyH(h, FRAME_W, 0);
  const ang = (Math.atan2(x.y - o.y, x.x - o.x) * 180) / Math.PI;
  const a = ((Math.round(ang / 90) * 90) % 360 + 360) % 360;
  return a as 0 | 90 | 180 | 270;
}

// ---------------------------------------------------------------------------
// Bubble alignment and measurement

function ringScore(c: Canvas, px: number, py: number, ring: Point[], outer: Point[]): number {
  return meanAt(c.dark, px, py, ring) - meanAt(c.dark, px, py, outer);
}

interface RingSet {
  ring: Point[];
  outer: Point[];
}

function ringSet(c: Canvas, rMm: number, outerGapMm: number): RingSet {
  return { ring: circlePoints(rMm * c.s), outer: circlePoints((rMm + outerGapMm) * c.s) };
}

/** Finds the pixel offset maximising the summed ring score of a group of bubbles. */
function alignGroup(c: Canvas, centers: Point[], rs: RingSet, rangePx: number, coarseStep: number, base: Point = { x: 0, y: 0 }): { offset: Point; score: number } {
  const evalAt = (ox: number, oy: number) => {
    let s = 0;
    for (const p of centers) s += ringScore(c, p.x + ox, p.y + oy, rs.ring, rs.outer);
    return s / centers.length;
  };
  let best = { x: base.x, y: base.y };
  let bestScore = evalAt(base.x, base.y);
  for (let oy = -rangePx; oy <= rangePx; oy += coarseStep)
    for (let ox = -rangePx; ox <= rangePx; ox += coarseStep) {
      const s = evalAt(base.x + ox, base.y + oy);
      if (s > bestScore) {
        bestScore = s;
        best = { x: base.x + ox, y: base.y + oy };
      }
    }
  if (coarseStep > 1) {
    const cx = best.x;
    const cy = best.y;
    for (let oy = -coarseStep; oy <= coarseStep; oy++)
      for (let ox = -coarseStep; ox <= coarseStep; ox++) {
        const s = evalAt(cx + ox, cy + oy);
        if (s > bestScore) {
          bestScore = s;
          best = { x: cx + ox, y: cy + oy };
        }
      }
  }
  return { offset: best, score: bestScore };
}

function medianPoint(pts: Point[]): Point {
  const xs = pts.map((p) => p.x).sort((a, b) => a - b);
  const ys = pts.map((p) => p.y).sort((a, b) => a - b);
  return { x: xs[xs.length >> 1], y: ys[ys.length >> 1] };
}

interface AlignedLayout {
  /** Pixel centres per question, per choice. */
  answers: Point[][];
  /** Pixel centres per ID column, per digit. */
  id: Point[][];
  ringScores: number[];
}

function alignLayout(c: Canvas, layout: SheetLayout): AlignedLayout {
  const ansRings = ringSet(c, BUBBLE_R, 0.9);
  const idRings = ringSet(c, ID_BUBBLE_R, 0.55);
  const answers: Point[][] = layout.questions.map((q) => q.bubbles.map((b) => toPx(c, b)));
  const ringScores: number[] = [];

  for (let col = 0; col < layout.columns.length; col++) {
    const qIdx = layout.questions.map((q, i) => (q.column === col ? i : -1)).filter((i) => i >= 0);
    const centers = qIdx.flatMap((i) => answers[i]);
    const colAlign = alignGroup(c, centers, ansRings, Math.round(2.2 * c.s), 2);
    // Row-level refinement relative to the column offset, then median smoothing.
    const rowOffsets = qIdx.map((i) => alignGroup(c, answers[i], ansRings, Math.round(0.8 * c.s), 1, colAlign.offset).offset);
    qIdx.forEach((qi, k) => {
      const window = rowOffsets.slice(Math.max(0, k - 1), Math.min(rowOffsets.length, k + 2));
      const off = medianPoint(window);
      answers[qi] = answers[qi].map((p) => ({ x: p.x + off.x, y: p.y + off.y }));
      for (const p of answers[qi]) ringScores.push(ringScore(c, p.x, p.y, ansRings.ring, ansRings.outer));
    });
  }

  const idCenters = layout.idColumns.map((col) => col.bubbles.map((b) => toPx(c, b)));
  const idAlign = alignGroup(c, idCenters.flat(), idRings, Math.round(1.6 * c.s), 2);
  const id = idCenters.map((col) => col.map((p) => ({ x: p.x + idAlign.offset.x, y: p.y + idAlign.offset.y })));
  return { answers, id, ringScores };
}

function measureFills(c: Canvas, centers: Point[][], rMm: number): number[][] {
  const disk = diskOffsets(rMm * 0.6 * c.s);
  return centers.map((row) => row.map((p) => meanAt(c.dark, p.x, p.y, disk)));
}

function inkLevel(c: Canvas, layout: SheetLayout, bits: number[]): number {
  const vals: number[] = [];
  const disk = diskOffsets(layout.codeCells[0].size * 0.3 * c.s);
  layout.codeCells.forEach((cell, i) => {
    if (bits[i]) {
      const p = toPx(c, cell);
      vals.push(meanAt(c.dark, p.x, p.y, disk));
    }
  });
  vals.sort((a, b) => a - b);
  return vals.length ? vals[vals.length >> 1] : 0.85;
}

// ---------------------------------------------------------------------------

async function decode(input: Buffer): Promise<GrayImage | null> {
  try {
    const { data, info } = await sharp(input, { limitInputPixels: 80_000_000, failOn: 'error' })
      .rotate() // honour EXIF orientation
      .resize({ width: MAX_DECODE_SIDE, height: MAX_DECODE_SIDE, fit: 'inside', withoutEnlargement: true })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return fromUint8(info.width, info.height, data, info.channels);
  } catch {
    return null;
  }
}

interface Located {
  h: Homography;
  bits: number[];
  codeVerified: boolean;
  payload: { version: number; quizCode: number; questionCount: number; choiceCount: number };
  uncertainCells: number;
}

type LocateResult = { located: Located } | { located: null; sentinelSeen: boolean };

function locate(src: GrayImage, quads: MarkerQuad[], scaleUp: number, expected: ExpectedLayout | undefined): LocateResult {
  const probeLayout = computeSheetLayout({ questionCount: 1, choiceCount: 2 }); // code strip is layout-independent
  let sentinelSeen = false;
  for (const quad of quads) {
    for (let rot = 0; rot < 4; rot++) {
      const h = homographyFor(quad, rot, scaleUp);
      if (!h) continue;
      const code = readCode(src, h, probeLayout);
      const dec = decodeSheetCode(code.bits);
      if (dec.ok) return { located: { h, bits: code.bits, codeVerified: true, payload: dec.payload, uncertainCells: code.uncertainCells } };
      if (dec.reason !== 'sentinel') sentinelSeen = true;
    }
  }
  const located = expected ? fallbackLocate(src, quads, scaleUp, expected) : null;
  return located ? { located } : { located: null, sentinelSeen };
}

function fallbackLocate(src: GrayImage, quads: MarkerQuad[], scaleUp: number, expected: ExpectedLayout): Located | null {

  // Fallback: the code strip is damaged but the teacher told us which quiz this is.
  // Choose the quad/orientation whose printed bubble rings line up best with that layout.
  const layout = computeSheetLayout(expected);
  const scored: { h: Homography; score: number }[] = [];
  for (const quad of quads.slice(0, 3)) {
    for (let rot = 0; rot < 4; rot++) {
      const h = homographyFor(quad, rot, scaleUp);
      if (!h) continue;
      const s = 3;
      const canvas: Canvas = { dark: normalizeIllumination(warpFrame(src, h, s, MARGIN_MM), 6 * s), s, margin: MARGIN_MM };
      const rs = ringSet(canvas, BUBBLE_R, 0.9);
      let total = 0;
      for (const q of layout.questions) for (const b of q.bubbles) {
        const p = toPx(canvas, b);
        total += ringScore(canvas, p.x, p.y, rs.ring, rs.outer);
      }
      scored.push({ h, score: total / (layout.questions.length * layout.choiceCount) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score < 0.12 || (scored[1] && scored[0].score < scored[1].score * 1.5)) return null;
  return {
    h: scored[0].h,
    bits: [],
    codeVerified: false,
    payload: { version: 1, quizCode: expected.quizCode ?? 0, questionCount: expected.questionCount, choiceCount: expected.choiceCount },
    uncertainCells: CODE_BITS,
  };
}

function readStudentId(fills: number[][], cal: ReturnType<typeof calibrate>): DetectedStudentId {
  const idCal = calibrate(fills, cal.ink);
  // ID marks come from the same student (or are pre-printed), so reuse the answer mark level.
  const merged = { ...idCal, markLevel: cal.markLevel, filled: cal.filled, faint: cal.faint };
  const digits = fills.map((raw) => {
    const rel = relativeFills(raw, merged);
    const c = classifyBubbles(rel, merged);
    return { status: c.status, digit: c.status === 'ok' ? c.choice : null, fills: rel };
  });
  const statuses = digits.map((d) => d.status);
  if (statuses.every((s) => s === 'blank')) return { value: null, status: 'blank', digits, note: 'No student ID bubbled' };
  if (statuses.some((s) => s === 'multiple' || s === 'ambiguous')) {
    return { value: null, status: 'ambiguous', digits, note: 'One or more ID digits are unclear' };
  }
  // Allow blank columns only at the start or end (IDs shorter than the grid).
  const first = statuses.indexOf('ok');
  const last = statuses.lastIndexOf('ok');
  if (statuses.slice(first, last + 1).some((s) => s === 'blank')) {
    return { value: null, status: 'ambiguous', digits, note: 'Blank column in the middle of the student ID' };
  }
  return { value: digits.slice(first, last + 1).map((d) => d.digit).join(''), status: 'ok', digits };
}

export async function scanAnswerSheet(input: Buffer, opts: ScanOptions = {}): Promise<ScanOutput> {
  const t0 = Date.now();
  const warnings: string[] = [];
  const src = await decode(input);
  if (!src) return fail('IMAGE_UNREADABLE');
  if (Math.min(src.width, src.height) < 700) return fail('RESOLUTION_TOO_LOW');

  const { mean, std } = meanAndStd(src);
  if (mean < 35) return fail('TOO_DARK');
  if (mean > 245) return fail('OVEREXPOSED');
  if (std < 6) return fail('MARKERS_NOT_FOUND');
  if (mean < 70) warnings.push('The photo is quite dark; results may be less reliable.');

  const factor = Math.max(1, Math.floor(Math.max(src.width, src.height) / 1000));
  const small = downscale(src, factor);
  const candidates = detectMarkerCandidates(small);
  const quads = findMarkerQuads(candidates, small.width, small.height);
  if (!quads.length) return fail('MARKERS_NOT_FOUND', warnings);

  const loc = locate(src, quads, factor, opts.expected);
  if (!loc.located) return fail(loc.sentinelSeen ? 'SHEET_CODE_UNREADABLE' : 'MARKERS_NOT_FOUND', warnings);
  const located = loc.located;
  const { payload } = located;
  if (payload.questionCount > MAX_QUESTIONS || payload.choiceCount > MAX_CHOICES || payload.version !== 1) {
    return fail('LAYOUT_UNSUPPORTED', warnings);
  }
  if (!located.codeVerified) {
    warnings.push('The sheet code strip could not be read; the selected quiz layout was assumed. Confirm this sheet belongs to the selected quiz.');
  } else if (located.uncertainCells > 3) {
    warnings.push('Parts of the sheet code strip are faint; the code still passed its checksum.');
  }
  const layout = computeSheetLayout({ questionCount: payload.questionCount, choiceCount: payload.choiceCount });

  const warped = warpFrame(src, located.h, PX_PER_MM, MARGIN_MM);
  const canvas: Canvas = { dark: normalizeIllumination(warped, 6 * PX_PER_MM), s: PX_PER_MM, margin: MARGIN_MM };

  const aligned = alignLayout(canvas, layout);
  const clarity = aligned.ringScores.reduce((a, b) => a + b, 0) / Math.max(1, aligned.ringScores.length);
  const ink = located.codeVerified ? inkLevel(canvas, layout, located.bits) : 0.85;
  if (clarity < 0.07) return fail('TOO_BLURRY', warnings);
  if (clarity < 0.14) warnings.push('The photo looks slightly blurry; double-check flagged answers.');
  if (ink < 0.45) warnings.push('Printed black looks washed out (low contrast or glare); double-check flagged answers.');

  const answerRaw = measureFills(canvas, aligned.answers, BUBBLE_R);
  const cal = calibrate(answerRaw, ink);
  const answers: DetectedAnswer[] = layout.questions.map((q, i) => {
    const rel = relativeFills(answerRaw[i], cal);
    const c = classifyBubbles(rel, cal);
    return { question: q.number, status: c.status, choice: c.status === 'multiple' ? null : c.choice, marked: c.marked, fills: rel, confidence: c.confidence, note: c.note };
  });

  const idRaw = measureFills(canvas, aligned.id, ID_BUBBLE_R);
  const studentId = readStudentId(idRaw, cal);

  const flaggedCount = answers.filter((a) => a.status === 'ambiguous' || a.status === 'multiple').length;
  const result: ScanSuccess = {
    ok: true,
    sheet: payload,
    codeVerified: located.codeVerified,
    orientation: orientationOf(located.h),
    studentId,
    answers,
    quality: {
      brightness: Math.round(mean),
      clarity: round3(clarity),
      inkLevel: round3(ink),
      emptyLevel: round3(cal.empty),
      markLevel: round3(cal.markLevel),
    },
    warnings,
    flaggedCount,
    rectified: { pxPerMm: PX_PER_MM, marginMm: MARGIN_MM, width: warped.width, height: warped.height },
    timingMs: 0,
  };

  let rectifiedJpeg: Buffer | undefined;
  if (opts.rectifiedImage) {
    // Show the teacher the illumination-corrected sheet, which reads best on screen.
    const view = createImage(warped.width, warped.height);
    for (let i = 0; i < view.data.length; i++) view.data[i] = 255 * (1 - canvas.dark.data[i]);
    rectifiedJpeg = await sharp(toUint8(view), { raw: { width: view.width, height: view.height, channels: 1 } }).jpeg({ quality: 78 }).toBuffer();
  }
  result.timingMs = Date.now() - t0;
  return { result, rectifiedJpeg };
}

function round3(v: number) {
  return Math.round(v * 1000) / 1000;
}

export type { Bubble };
