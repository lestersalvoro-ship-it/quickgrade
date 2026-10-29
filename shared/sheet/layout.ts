/**
 * QuickGrade answer-sheet layout — the single source of truth for where every
 * printed element lives. The PDF generator draws from this layout and the
 * scanner samples from it, so the two can never drift apart.
 *
 * Coordinate system: millimetres in "frame space". The origin is the centre of
 * the top-left registration marker; x grows right, y grows down. The four
 * marker centres sit at (0,0), (FRAME_W,0), (FRAME_W,FRAME_H) and (0,FRAME_H).
 * The frame is centred on the physical page (A4 or US Letter both fit), so the
 * scanner never needs to know which paper size was used.
 */

export const SHEET_TEMPLATE_VERSION = 1;

export const FRAME_W = 180;
export const FRAME_H = 250;
export const MARKER_SIZE = 8;

export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 100;
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 5;
export const CHOICE_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;
export type ChoiceLetter = (typeof CHOICE_LETTERS)[number];

export const STUDENT_ID_DIGITS = 8;

/** Sheet code: 4 sentinel bits + 32 payload bits + 8 CRC bits. */
export const CODE_SENTINEL = [1, 1, 0, 1] as const;
export const CODE_BITS = 44;
export const CODE_CELL = 2.8;
const CODE_X0 = 12;
const CODE_X1 = 168;

export const BUBBLE_R = 2.2;
export const ID_BUBBLE_R = 1.8;

export interface Point {
  x: number;
  y: number;
}

export interface Bubble extends Point {
  r: number;
}

export interface CodeCell extends Point {
  /** Side length of the square cell. */
  size: number;
}

export interface QuestionRow {
  number: number;
  /** Centre of the question-number label. */
  label: Point;
  column: number;
  rowInColumn: number;
  bubbles: Bubble[];
}

export interface IdColumn {
  digitIndex: number;
  /** Box where the student writes the digit by hand. */
  writeBox: { x: number; y: number; w: number; h: number };
  /** bubbles[d] is the bubble for digit d (0–9). */
  bubbles: Bubble[];
}

export interface SheetLayout {
  version: number;
  questionCount: number;
  choiceCount: number;
  frame: { w: number; h: number };
  markers: Point[];
  codeCells: CodeCell[];
  /** Blank-paper sample points just below the code row, used as a white reference. */
  codeWhiteRefs: Point[];
  idColumns: IdColumn[];
  questions: QuestionRow[];
  columns: { x: number; headerY: number; rows: number }[];
  rowPitch: number;
  answerArea: { x: number; y: number; w: number; h: number };
}

export interface LayoutOptions {
  questionCount: number;
  choiceCount: number;
}

export function validateLayoutOptions({ questionCount, choiceCount }: LayoutOptions): string | null {
  if (!Number.isInteger(questionCount) || questionCount < MIN_QUESTIONS || questionCount > MAX_QUESTIONS) {
    return `Question count must be a whole number between ${MIN_QUESTIONS} and ${MAX_QUESTIONS}.`;
  }
  if (!Number.isInteger(choiceCount) || choiceCount < MIN_CHOICES || choiceCount > MAX_CHOICES) {
    return `Choices per question must be between ${MIN_CHOICES} and ${MAX_CHOICES}.`;
  }
  return null;
}

/** Number of answer columns used for a given quiz length. */
export function columnCountFor(questionCount: number): number {
  return Math.min(4, Math.max(Math.ceil(questionCount / 25), Math.ceil(questionCount / 10)));
}

const layoutCache = new Map<string, SheetLayout>();

export function computeSheetLayout(opts: LayoutOptions): SheetLayout {
  const err = validateLayoutOptions(opts);
  if (err) throw new Error(err);
  const key = `${opts.questionCount}:${opts.choiceCount}`;
  const cached = layoutCache.get(key);
  if (cached) return cached;

  const { questionCount, choiceCount } = opts;

  const markers: Point[] = [
    { x: 0, y: 0 },
    { x: FRAME_W, y: 0 },
    { x: FRAME_W, y: FRAME_H },
    { x: 0, y: FRAME_H },
  ];

  // Sheet code row, centred on the line joining the two top markers.
  const codePitch = (CODE_X1 - CODE_X0) / (CODE_BITS - 1);
  const codeCells: CodeCell[] = [];
  const codeWhiteRefs: Point[] = [];
  for (let i = 0; i < CODE_BITS; i++) {
    const x = CODE_X0 + i * codePitch;
    codeCells.push({ x, y: 0, size: CODE_CELL });
    codeWhiteRefs.push({ x, y: 3.6 });
  }

  // Student ID grid (top right): write-in boxes, then 10 bubble rows.
  const idPitchX = 5.2;
  const idPitchY = 4.5;
  const idX0 = FRAME_W - 6 - (STUDENT_ID_DIGITS - 1) * idPitchX;
  const idBoxY = 14;
  const idY0 = 22;
  const idColumns: IdColumn[] = [];
  for (let c = 0; c < STUDENT_ID_DIGITS; c++) {
    const x = idX0 + c * idPitchX;
    const bubbles: Bubble[] = [];
    for (let d = 0; d < 10; d++) bubbles.push({ x, y: idY0 + d * idPitchY, r: ID_BUBBLE_R });
    idColumns.push({ digitIndex: c, writeBox: { x: x - 2.3, y: idBoxY - 2.6, w: 4.6, h: 5.2 }, bubbles });
  }

  // Answer area.
  const area = { x: 0, y: 72, w: FRAME_W, h: 170 };
  const cols = columnCountFor(questionCount);
  const rowsPerCol = Math.ceil(questionCount / cols);
  const headerH = 6;
  const rowPitch = Math.min(7.5, (area.h - headerH) / rowsPerCol);
  const choicePitch = 6.2;
  const labelW = 8;
  const blockW = labelW + choicePitch * choiceCount;
  const colW = area.w / cols;

  const columns: SheetLayout['columns'] = [];
  const questions: QuestionRow[] = [];
  for (let c = 0; c < cols; c++) {
    const colX = area.x + c * colW + (colW - blockW) / 2;
    const rows = Math.min(rowsPerCol, questionCount - c * rowsPerCol);
    if (rows <= 0) break;
    columns.push({ x: colX, headerY: area.y + headerH / 2, rows });
    for (let r = 0; r < rows; r++) {
      const number = c * rowsPerCol + r + 1;
      const y = area.y + headerH + rowPitch * (r + 0.5);
      const bubbles: Bubble[] = [];
      for (let k = 0; k < choiceCount; k++) {
        bubbles.push({ x: colX + labelW + choicePitch * (k + 0.5), y, r: BUBBLE_R });
      }
      questions.push({ number, label: { x: colX + labelW / 2 - 0.5, y }, column: c, rowInColumn: r, bubbles });
    }
  }

  const layout: SheetLayout = {
    version: SHEET_TEMPLATE_VERSION,
    questionCount,
    choiceCount,
    frame: { w: FRAME_W, h: FRAME_H },
    markers,
    codeCells,
    codeWhiteRefs,
    idColumns,
    questions,
    columns,
    rowPitch,
    answerArea: area,
  };
  layoutCache.set(key, layout);
  return layout;
}

/** Paper sizes in millimetres. */
export const PAPER_SIZES = {
  A4: { w: 210, h: 297 },
  LETTER: { w: 215.9, h: 279.4 },
} as const;
export type PaperSize = keyof typeof PAPER_SIZES;

/** Page position (mm) of the frame origin, so the frame is centred on the page. */
export function frameOriginOnPage(paper: PaperSize): Point {
  const p = PAPER_SIZES[paper];
  return { x: (p.w - FRAME_W) / 2, y: (p.h - FRAME_H) / 2 };
}
