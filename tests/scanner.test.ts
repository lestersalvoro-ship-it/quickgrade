import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { computeSheetLayout, frameOriginOnPage } from '../shared/sheet/layout';
import { scanAnswerSheet } from '../server/src/scanner/scan';
import type { ScanSuccess } from '../shared/scan-types';
import { hasPdftoppm, photograph, renderFilledSheet, rng, type Mark, type PhotoOptions } from './helpers/synthetic';

const canRender = hasPdftoppm();
const d = canRender ? describe : describe.skip;

interface Truth {
  answers: (number | null)[];
  marks: Mark[];
}

function randomTruth(n: number, choices: number, seed: number, style: Mark['style'], blankEvery = 13): Truth {
  const r = rng(seed);
  const answers: (number | null)[] = [];
  const marks: Mark[] = [];
  for (let q = 1; q <= n; q++) {
    if (q % blankEvery === 0) {
      answers.push(null);
      continue;
    }
    const c = Math.floor(r() * choices);
    answers.push(c);
    marks.push({ question: q, choice: c, style });
  }
  return { answers, marks };
}

function idMarks(id: string): Mark[] {
  return id.split('').map((digit, column) => ({ idDigit: { column, digit: Number(digit) }, style: 'pen' as const }));
}

/** Every answer the scanner did NOT flag must match the ground truth exactly. */
function assertNoSilentErrors(res: ScanSuccess, truth: (number | null)[]) {
  for (const a of res.answers) {
    const t = truth[a.question - 1];
    if (a.status === 'ok') expect({ q: a.question, choice: a.choice }).toEqual({ q: a.question, choice: t });
    if (a.status === 'blank') expect({ q: a.question, blank: t }).toEqual({ q: a.question, blank: null });
  }
}

async function scanOk(photo: Buffer, expected?: { questionCount: number; choiceCount: number }): Promise<ScanSuccess> {
  const { result } = await scanAnswerSheet(photo, { expected });
  if (!result.ok) throw new Error(`scan failed: ${result.error.code}`);
  return result;
}

const PHOTO_CONDITIONS: Record<string, PhotoOptions> = {
  'flat, even light': {},
  'tilted with keystone perspective': { rotate: 7, perspective: 0.7, seed: 2 },
  'uneven light and shadow': { dimSide: 0.45, shadow: 0.4, seed: 3 },
  'noise, mild blur, heavy JPEG': { noise: 10, blurSigma: 1.2, jpegQuality: 55, seed: 4 },
  'upside down': { rotate: 180, perspective: 0.3, seed: 5 },
  'landscape, rotated 90°': { rotate: 90, width: 2000, height: 1500, seed: 6 },
  'small in frame (far away)': { scale: 0.55, seed: 8 },
  'everything at once': { rotate: -12, perspective: 0.6, dimSide: 0.55, shadow: 0.3, noise: 8, blurSigma: 1, jpegQuality: 65, seed: 9 },
};

d('scanner accuracy against ground truth', () => {
  for (const [n, choices, style] of [
    [20, 5, 'pen'],
    [50, 4, 'pencil'],
    [100, 4, 'pencil'],
  ] as const) {
    describe(`${n} questions, ${choices} choices, ${style}`, async () => {
      const truth = randomTruth(n, choices, n * 7 + choices, style);
      const sheetPromise = renderFilledSheet({ questionCount: n, choiceCount: choices, sheetCode: 4242 + n, marks: [...truth.marks, ...idMarks('20240117')] }, n);

      for (const [name, opts] of Object.entries(PHOTO_CONDITIONS)) {
        it(name, async () => {
          const sheet = await sheetPromise;
          const res = await scanOk(await photograph(sheet.png, opts));
          expect(res.sheet).toEqual({ version: 1, quizCode: 4242 + n, questionCount: n, choiceCount: choices });
          expect(res.codeVerified).toBe(true);
          expect(res.studentId.value).toBe('20240117');
          assertNoSilentErrors(res, truth.answers);
          // Clean, deliberate marks should read without needing review.
          expect(res.flaggedCount).toBe(0);
          const correct = res.answers.filter((a) => a.choice === truth.answers[a.question - 1] || (a.status === 'blank' && truth.answers[a.question - 1] === null));
          expect(correct.length).toBe(n);
        });
      }
    });
  }

  it('reads US Letter sheets', async () => {
    const truth = randomTruth(50, 4, 99, 'pen');
    const sheet = await renderFilledSheet({ questionCount: 50, choiceCount: 4, sheetCode: 31337, paper: 'LETTER', marks: truth.marks });
    const res = await scanOk(await photograph(sheet.png, { rotate: 4, perspective: 0.4 }));
    expect(res.sheet.quizCode).toBe(31337);
    assertNoSilentErrors(res, truth.answers);
    expect(res.flaggedCount).toBe(0);
    expect(res.studentId.status).toBe('blank');
  });

  it('reads pre-printed student IDs on personalised sheets', async () => {
    const sheet = await renderFilledSheet({
      questionCount: 20,
      choiceCount: 4,
      sheetCode: 777,
      student: { name: 'Test Student', studentNumber: '4815', className: '8-A' },
      marks: [{ question: 1, choice: 2, style: 'pen' }],
    });
    const res = await scanOk(await photograph(sheet.png, { rotate: 3 }));
    // Pre-printed IDs are zero-padded to the full grid width.
    expect(res.studentId.value).toBe('00004815');
  });
});

d('scanner flags uncertain marks instead of guessing', () => {
  const marks: Mark[] = [
    { question: 1, choice: 1, style: 'pen' },
    { question: 2, choice: 1, style: 'pencil' },
    { question: 3, choice: 1, style: 'light-pencil' },
    { question: 4, choice: 1, style: 'partial' },
    { question: 5, choice: 1, style: 'erased' },
    { question: 6, choice: 1, style: 'check' },
    { question: 7, choice: 0, style: 'pen' },
    { question: 7, choice: 2, style: 'pen' },
    { question: 8, choice: 3, style: 'pen' },
    { question: 8, choice: 1, style: 'erased' },
    { question: 9, choice: 0, style: 'pencil' },
    { question: 9, choice: 2, style: 'light-pencil' },
    ...Array.from({ length: 10 }, (_, i) => ({ question: 11 + i, choice: (11 + i) % 4, style: 'pencil' as const })),
  ];
  const sheetPromise = renderFilledSheet({ questionCount: 20, choiceCount: 4, sheetCode: 5, marks });

  for (const [name, opts] of Object.entries({ clean: {}, harsh: PHOTO_CONDITIONS['everything at once'] })) {
    it(`classifies difficult marks (${name})`, async () => {
      const res = await scanOk(await photograph((await sheetPromise).png, opts));
      const byQ = (q: number) => res.answers[q - 1];
      expect(byQ(1)).toMatchObject({ status: 'ok', choice: 1 });
      expect(byQ(2)).toMatchObject({ status: 'ok', choice: 1 });
      expect(byQ(3)).toMatchObject({ status: 'ok', choice: 1 });
      expect(byQ(4).status).toBe('ambiguous'); // partial tick
      expect(byQ(5).status).not.toBe('ok'); // erased only → blank or flagged, never an answer
      expect(byQ(6).status).toBe('ambiguous'); // check mark
      expect(byQ(7)).toMatchObject({ status: 'multiple', marked: [0, 2] });
      expect(byQ(8)).toMatchObject({ status: 'ok', choice: 3 }); // clean erasure next to a real mark
      expect(byQ(9).status).toBe('multiple');
      expect(byQ(10).status).toBe('blank');
      for (let q = 11; q <= 20; q++) expect(byQ(q)).toMatchObject({ status: 'ok', choice: q % 4 });
      expect(res.flaggedCount).toBeGreaterThanOrEqual(4);
    });
  }
});

d('scanner error handling', () => {
  const sheetPromise = renderFilledSheet({ questionCount: 20, choiceCount: 4, sheetCode: 1234, marks: [{ question: 1, choice: 0, style: 'pen' }] });

  it('rejects non-image data', async () => {
    const { result } = await scanAnswerSheet(Buffer.from('definitely not an image'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('IMAGE_UNREADABLE');
  });

  it('rejects images that are too small', async () => {
    const tiny = await sharp((await sheetPromise).png).resize(400).jpeg().toBuffer();
    const { result } = await scanAnswerSheet(tiny);
    expect(!result.ok && result.error.code).toBe('RESOLUTION_TOO_LOW');
  });

  it('rejects photos with no sheet', async () => {
    const r = rng(3);
    const raw = Buffer.alloc(1200 * 1600);
    for (let i = 0; i < raw.length; i++) raw[i] = 90 + Math.floor(r() * 80);
    const img = await sharp(raw, { raw: { width: 1200, height: 1600, channels: 1 } }).blur(3).jpeg().toBuffer();
    const { result } = await scanAnswerSheet(img);
    expect(!result.ok && result.error.code).toBe('MARKERS_NOT_FOUND');
  });

  it('rejects photos where a corner marker is cut off', async () => {
    const photo = await photograph((await sheetPromise).png, { scale: 0.95 });
    const meta = await sharp(photo).metadata();
    // Crop away the right-hand side of the photo, removing two markers.
    const cropped = await sharp(photo).extract({ left: 0, top: 0, width: Math.round(meta.width! * 0.8), height: meta.height! }).jpeg().toBuffer();
    const { result } = await scanAnswerSheet(cropped);
    expect(!result.ok && result.error.code).toBe('MARKERS_NOT_FOUND');
  });

  it('rejects very dark photos', async () => {
    const photo = await photograph((await sheetPromise).png);
    const dark = await sharp(photo).linear(0.12, 0).jpeg().toBuffer();
    const { result } = await scanAnswerSheet(dark);
    expect(!result.ok && result.error.code).toBe('TOO_DARK');
  });

  it('rejects badly blurred photos', async () => {
    const photo = await photograph((await sheetPromise).png, { blurSigma: 9 });
    const { result } = await scanAnswerSheet(photo);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(['TOO_BLURRY', 'MARKERS_NOT_FOUND', 'SHEET_CODE_UNREADABLE']).toContain(result.error.code);
  });

  it('detects a damaged code strip, and falls back to the selected quiz layout with a warning', async () => {
    const sheet = await sheetPromise;
    const origin = frameOriginOnPage('A4');
    const layout = computeSheetLayout({ questionCount: 20, choiceCount: 4 });
    const s = sheet.pxPerMm;
    // Scribble over the middle of the code strip.
    const x0 = (origin.x + layout.codeCells[14].x) * s;
    const x1 = (origin.x + layout.codeCells[30].x) * s;
    const y = origin.y * s;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.width}" height="${sheet.height}"><rect x="${x0}" y="${y - 2 * s}" width="${x1 - x0}" height="${4 * s}" fill="#111"/></svg>`;
    const damaged = await sharp(sheet.png).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
    const photo = await photograph(damaged, { rotate: 5 });

    const plain = await scanAnswerSheet(photo);
    expect(!plain.result.ok && plain.result.error.code).toBe('SHEET_CODE_UNREADABLE');

    const res = await scanOk(photo, { questionCount: 20, choiceCount: 4 });
    expect(res.codeVerified).toBe(false);
    expect(res.warnings.join(' ')).toMatch(/code strip/);
    expect(res.answers[0]).toMatchObject({ status: 'ok', choice: 0 });
  });
});
