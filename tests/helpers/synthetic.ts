/**
 * Builds representative "phone photos" of filled answer sheets for scanner tests:
 * the real generated PDF is rasterised with poppler (pdftoppm), marks are drawn
 * where a student would fill bubbles, and the page is then perspective-warped,
 * unevenly lit, blurred, noised and JPEG-compressed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { computeSheetLayout, frameOriginOnPage, PAPER_SIZES, type PaperSize } from '../../shared/sheet/layout';
import { renderAnswerSheetPdf, type SheetStudentInfo } from '../../server/src/pdf/answerSheet';
import { homographyFrom4, applyH } from '../../server/src/scanner/geometry';

export function hasPdftoppm(): boolean {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Deterministic PRNG so tests are reproducible. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

export type MarkStyle = 'pen' | 'pencil' | 'light-pencil' | 'partial' | 'erased' | 'check';

export interface Mark {
  question?: number; // 1-based
  choice?: number; // 0-based
  idDigit?: { column: number; digit: number };
  style: MarkStyle;
}

export interface SheetSpec {
  questionCount: number;
  choiceCount: number;
  sheetCode: number;
  paper?: PaperSize;
  student?: SheetStudentInfo;
  marks: Mark[];
  dpi?: number;
}

export async function renderFilledSheet(spec: SheetSpec, seed = 1): Promise<{ png: Buffer; width: number; height: number; pxPerMm: number }> {
  const paper = spec.paper ?? 'A4';
  const dpi = spec.dpi ?? 150;
  const pdf = await renderAnswerSheetPdf({
    quiz: { title: 'Synthetic test quiz', subject: 'Testing', questionCount: spec.questionCount, choiceCount: spec.choiceCount, sheetCode: spec.sheetCode },
    paper,
    students: spec.student ? [spec.student] : undefined,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-'));
  const pdfPath = path.join(dir, 'sheet.pdf');
  fs.writeFileSync(pdfPath, pdf);
  execFileSync('pdftoppm', ['-r', String(dpi), '-gray', '-png', '-singlefile', pdfPath, path.join(dir, 'page')]);
  const pagePng = fs.readFileSync(path.join(dir, 'page.png'));
  fs.rmSync(dir, { recursive: true, force: true });

  const meta = await sharp(pagePng).metadata();
  const pxPerMm = dpi / 25.4;
  const origin = frameOriginOnPage(paper);
  const layout = computeSheetLayout({ questionCount: spec.questionCount, choiceCount: spec.choiceCount });
  const rand = rng(seed);
  const P = (x: number, y: number) => ({ x: (origin.x + x) * pxPerMm, y: (origin.y + y) * pxPerMm });

  const shapes: string[] = [];
  for (const m of spec.marks) {
    let b: { x: number; y: number; r: number } | undefined;
    if (m.question !== undefined && m.choice !== undefined) b = layout.questions[m.question - 1].bubbles[m.choice];
    if (m.idDigit) b = layout.idColumns[m.idDigit.column].bubbles[m.idDigit.digit];
    if (!b) throw new Error('bad mark');
    const c = P(b.x + (rand() - 0.5) * 0.5, b.y + (rand() - 0.5) * 0.5);
    const r = b.r * pxPerMm;
    const rx = r * (0.92 + rand() * 0.12);
    const ry = r * (0.9 + rand() * 0.12);
    const rot = Math.round(rand() * 180);
    switch (m.style) {
      case 'pen':
        shapes.push(`<ellipse cx="${c.x}" cy="${c.y}" rx="${rx}" ry="${ry}" transform="rotate(${rot} ${c.x} ${c.y})" fill="#1a1a2e" fill-opacity="0.95"/>`);
        break;
      case 'pencil':
        shapes.push(`<ellipse cx="${c.x}" cy="${c.y}" rx="${rx}" ry="${ry}" transform="rotate(${rot} ${c.x} ${c.y})" fill="#3a3a3a" fill-opacity="0.72" filter="url(#grain)"/>`);
        break;
      case 'light-pencil':
        shapes.push(`<ellipse cx="${c.x}" cy="${c.y}" rx="${rx * 0.95}" ry="${ry * 0.95}" transform="rotate(${rot} ${c.x} ${c.y})" fill="#555" fill-opacity="0.5" filter="url(#grain)"/>`);
        break;
      case 'partial':
        // A small tick of graphite covering a fraction of the bubble.
        shapes.push(`<ellipse cx="${c.x - r * 0.35}" cy="${c.y + r * 0.2}" rx="${r * 0.38}" ry="${r * 0.3}" fill="#333" fill-opacity="0.7"/>`);
        break;
      case 'erased':
        // Residue left after erasing a pencil mark.
        shapes.push(`<ellipse cx="${c.x}" cy="${c.y}" rx="${rx}" ry="${ry}" fill="#666" fill-opacity="0.16" filter="url(#grain)"/>`);
        break;
      case 'check':
        shapes.push(`<path d="M ${c.x - r * 0.6} ${c.y} L ${c.x - r * 0.1} ${c.y + r * 0.6} L ${c.x + r * 0.7} ${c.y - r * 0.7}" stroke="#222" stroke-width="${r * 0.18}" fill="none"/>`);
        break;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}">
    <defs><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${seed}" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.1 1.2" result="a"/>
      <feComposite in="SourceGraphic" in2="a" operator="in"/></filter></defs>
    ${shapes.join('\n')}
  </svg>`;
  const png = await sharp(pagePng).composite([{ input: Buffer.from(svg), blend: 'multiply' }]).grayscale().png().toBuffer();
  return { png, width: meta.width!, height: meta.height!, pxPerMm };
}

export interface PhotoOptions {
  /** Output canvas size. */
  width?: number;
  height?: number;
  /** Rotation of the page in the photo, degrees. */
  rotate?: number;
  /** Perspective strength 0–1 (keystone effect). */
  perspective?: number;
  /** Fraction of the canvas height the page occupies. */
  scale?: number;
  /** Lighting gradient: brightness at the dim side (1 = even). */
  dimSide?: number;
  /** Shadow blob darkness 0–1. */
  shadow?: number;
  blurSigma?: number;
  noise?: number;
  jpegQuality?: number;
  background?: number;
  seed?: number;
}

/** Simulates photographing a page. */
export async function photograph(pagePng: Buffer, opts: PhotoOptions = {}): Promise<Buffer> {
  const W = opts.width ?? 1500;
  const H = opts.height ?? 2000;
  const rand = rng(opts.seed ?? 7);
  const { data: page, info } = await sharp(pagePng).grayscale().raw().toBuffer({ resolveWithObject: true });
  const pw = info.width;
  const ph = info.height;

  // Destination quad for the page corners.
  const scale = ((opts.scale ?? 0.88) * H) / ph;
  const cw = pw * scale;
  const ch = ph * scale;
  const cx = W / 2 + (rand() - 0.5) * W * 0.04;
  const cy = H / 2 + (rand() - 0.5) * H * 0.04;
  const ang = ((opts.rotate ?? 0) * Math.PI) / 180;
  const k = opts.perspective ?? 0;
  const corners = [
    { x: -cw / 2 * (1 - k * 0.18), y: -ch / 2 },
    { x: cw / 2 * (1 - k * 0.18), y: -ch / 2 + k * ch * 0.03 },
    { x: cw / 2 * (1 + k * 0.05), y: ch / 2 },
    { x: -cw / 2 * (1 + k * 0.05), y: ch / 2 - k * ch * 0.02 },
  ].map((p) => ({ x: cx + p.x * Math.cos(ang) - p.y * Math.sin(ang), y: cy + p.x * Math.sin(ang) + p.y * Math.cos(ang) }));
  const hInv = homographyFrom4(corners, [
    { x: 0, y: 0 },
    { x: pw - 1, y: 0 },
    { x: pw - 1, y: ph - 1 },
    { x: 0, y: ph - 1 },
  ])!;

  const bg = opts.background ?? 70;
  const out = Buffer.alloc(W * H);
  const dim = opts.dimSide ?? 1;
  const shadow = opts.shadow ?? 0;
  const sx = W * (0.3 + rand() * 0.4);
  const sy = H * (0.3 + rand() * 0.4);
  const sr = Math.min(W, H) * 0.3;
  const noise = opts.noise ?? 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = applyH(hInv, x, y);
      let v: number;
      if (p.x < 0 || p.y < 0 || p.x > pw - 1 || p.y > ph - 1) {
        v = bg + ((x * 7 + y * 13) % 23) - 11; // textured table
      } else {
        const x0 = Math.floor(p.x);
        const y0 = Math.floor(p.y);
        const fx = p.x - x0;
        const fy = p.y - y0;
        const i = y0 * pw + x0;
        const x1 = x0 + 1 < pw ? 1 : 0;
        const y1 = y0 + 1 < ph ? pw : 0;
        const a = page[i] + (page[i + x1] - page[i]) * fx;
        const b = page[i + y1] + (page[i + y1 + x1] - page[i + y1]) * fx;
        v = a + (b - a) * fy;
      }
      const light = dim + (1 - dim) * (x / W);
      const d2 = ((x - sx) ** 2 + (y - sy) ** 2) / (sr * sr);
      const sh = 1 - shadow * Math.exp(-d2);
      v = v * light * sh * 0.96 + 4;
      if (noise) v += (rand() + rand() + rand() - 1.5) * noise;
      out[y * W + x] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  let img = sharp(out, { raw: { width: W, height: H, channels: 1 } });
  if (opts.blurSigma) img = img.blur(opts.blurSigma);
  return img.jpeg({ quality: opts.jpegQuality ?? 85 }).toBuffer();
}

export const PAGE_SIZES = PAPER_SIZES;
