import PDFDocument from 'pdfkit';
import {
  CHOICE_LETTERS,
  FRAME_H,
  FRAME_W,
  MARKER_SIZE,
  PAPER_SIZES,
  computeSheetLayout,
  frameOriginOnPage,
  type PaperSize,
  type SheetLayout,
} from '../../../shared/sheet/layout';
import { encodeSheetCode } from '../../../shared/sheet/code';

const MM = 72 / 25.4;

export interface SheetQuizInfo {
  title: string;
  subject?: string | null;
  questionCount: number;
  choiceCount: number;
  sheetCode: number;
}

export interface SheetStudentInfo {
  name: string;
  studentNumber: string;
  className?: string | null;
}

export interface AnswerSheetOptions {
  quiz: SheetQuizInfo;
  paper?: PaperSize;
  /** One personalised page per student (name printed, ID pre-bubbled). */
  students?: SheetStudentInfo[];
  /** Number of blank copies when no students are given. */
  copies?: number;
}

const INK = '#000000';
const RING = '#2b2b2b';
const LIGHT = '#9a9a9a';

function truncate(doc: PDFKit.PDFDocument, text: string, maxWidth: number): string {
  if (doc.widthOfString(text) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && doc.widthOfString(t + '…') > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

function drawPage(doc: PDFKit.PDFDocument, layout: SheetLayout, quiz: SheetQuizInfo, paper: PaperSize, student?: SheetStudentInfo) {
  const origin = frameOriginOnPage(paper);
  doc.save();
  // Draw everything in frame-space millimetres.
  doc.scale(MM).translate(origin.x, origin.y);

  // Registration markers.
  for (const m of layout.markers) {
    doc.rect(m.x - MARKER_SIZE / 2, m.y - MARKER_SIZE / 2, MARKER_SIZE, MARKER_SIZE).fill(INK);
  }

  // Sheet code strip.
  const bits = encodeSheetCode({
    version: layout.version,
    choiceCount: layout.choiceCount,
    questionCount: layout.questionCount,
    quizCode: quiz.sheetCode,
  });
  layout.codeCells.forEach((cell, i) => {
    if (bits[i]) doc.rect(cell.x - cell.size / 2, cell.y - cell.size / 2, cell.size, cell.size).fill(INK);
  });

  // Header: branding, quiz details, name lines.
  doc.fillColor('#1d4ed8').font('Helvetica-Bold').fontSize(5.2).text('QuickGrade', 6, 7.5, { lineBreak: false });
  doc.fillColor('#111111').font('Helvetica-Bold').fontSize(3.4);
  doc.text(truncate(doc, quiz.title, 118), 6, 14.5, { lineBreak: false });
  doc.font('Helvetica').fontSize(2.5).fillColor('#333333');
  const meta = [
    quiz.subject ? truncate(doc, quiz.subject, 60) : null,
    `${layout.questionCount} items`,
    `Choices ${CHOICE_LETTERS[0]}–${CHOICE_LETTERS[layout.choiceCount - 1]}`,
    `Sheet #${quiz.sheetCode}`,
  ]
    .filter(Boolean)
    .join('   ·   ');
  doc.text(meta, 6, 19.5, { lineBreak: false });

  const lineY = [29, 37, 45];
  const labels = ['Name', 'Class / Section', 'Date'];
  doc.font('Helvetica').fontSize(2.6).fillColor('#222222');
  labels.forEach((label, i) => {
    doc.text(label, 6, lineY[i] - 2.6, { lineBreak: false });
    doc.moveTo(30, lineY[i]).lineTo(126, lineY[i]).lineWidth(0.25).strokeColor('#555555').stroke();
  });
  if (student) {
    doc.font('Helvetica-Bold').fontSize(3.2).fillColor('#111111');
    doc.text(truncate(doc, student.name, 92), 32, lineY[0] - 3.4, { lineBreak: false });
    if (student.className) doc.text(truncate(doc, student.className, 92), 32, lineY[1] - 3.4, { lineBreak: false });
  }

  // Instructions.
  doc.roundedRect(6, 50, 120, 16, 1.5).lineWidth(0.25).strokeColor('#9ca3af').stroke();
  doc.font('Helvetica-Bold').fontSize(2.5).fillColor('#111111').text('Marking instructions', 9, 52, { lineBreak: false });
  doc.font('Helvetica').fontSize(2.3).fillColor('#333333');
  doc.text('Use a dark pencil (No. 2) or a black/blue pen. Fill ONE bubble completely per item:', 9, 56, { lineBreak: false });
  doc.circle(118, 57, 1.8).fill(INK);
  doc.text('Erase changes completely. Do not write on the black squares or the code strip.', 9, 59.5, { lineBreak: false });
  doc.text('Bubble your student ID below the boxes. Keep the sheet flat and uncreased.', 9, 63, { lineBreak: false });

  // Student ID grid.
  const firstCol = layout.idColumns[0];
  doc.font('Helvetica-Bold').fontSize(2.5).fillColor('#111111');
  doc.text('STUDENT ID', firstCol.writeBox.x, 8.3, { lineBreak: false });
  const digits = student ? student.studentNumber.padStart(layout.idColumns.length, '0') : null;
  for (const col of layout.idColumns) {
    const b = col.writeBox;
    doc.rect(b.x, b.y, b.w, b.h).lineWidth(0.25).strokeColor('#555555').stroke();
    const digit = digits ? Number(digits[col.digitIndex]) : null;
    if (digits) {
      doc.font('Helvetica-Bold').fontSize(3.2).fillColor('#111111');
      doc.text(String(digit), b.x, b.y + 1.1, { width: b.w, align: 'center', lineBreak: false });
    }
    col.bubbles.forEach((bub, d) => {
      if (digit === d) {
        doc.circle(bub.x, bub.y, bub.r).fill(INK);
      } else {
        doc.circle(bub.x, bub.y, bub.r).lineWidth(0.28).strokeColor(RING).stroke();
        doc.font('Helvetica').fontSize(2.0).fillColor(LIGHT);
        doc.text(String(d), bub.x - 1.5, bub.y - 0.75, { width: 3, align: 'center', lineBreak: false });
      }
    });
  }
  doc.font('Helvetica').fontSize(2.1).fillColor('#555555');
  for (let d = 0; d < 10; d++) {
    const y = firstCol.bubbles[d].y;
    doc.text(String(d), firstCol.bubbles[d].x - 5.2, y - 0.8, { width: 2, align: 'right', lineBreak: false });
  }

  // Answer columns.
  for (const col of layout.columns) {
    doc.font('Helvetica-Bold').fontSize(2.6).fillColor('#111111');
    const sample = layout.questions.find((q) => q.column === layout.columns.indexOf(col));
    if (sample) {
      sample.bubbles.forEach((bub, k) => {
        doc.text(CHOICE_LETTERS[k], bub.x - 2, col.headerY - 1, { width: 4, align: 'center', lineBreak: false });
      });
    }
  }
  for (const q of layout.questions) {
    doc.font('Helvetica-Bold').fontSize(2.7).fillColor('#111111');
    doc.text(String(q.number), q.label.x - 6, q.label.y - 1.0, { width: 8, align: 'right', lineBreak: false });
    q.bubbles.forEach((bub, k) => {
      doc.circle(bub.x, bub.y, bub.r).lineWidth(0.3).strokeColor(RING).stroke();
      doc.font('Helvetica').fontSize(2.1).fillColor(LIGHT);
      doc.text(CHOICE_LETTERS[k], bub.x - 1.5, bub.y - 0.8, { width: 3, align: 'center', lineBreak: false });
    });
  }

  // Footer between the bottom markers.
  doc.font('Helvetica').fontSize(2.1).fillColor('#6b7280');
  doc.text(
    `QuickGrade answer sheet · template v${layout.version} · Scan with all four corner squares visible`,
    10,
    FRAME_H - 1,
    { width: FRAME_W - 20, align: 'center', lineBreak: false },
  );

  doc.restore();
}

/** Renders a print-ready PDF and resolves with its bytes. */
export function renderAnswerSheetPdf(opts: AnswerSheetOptions): Promise<Buffer> {
  const paper = opts.paper ?? 'A4';
  const layout = computeSheetLayout({ questionCount: opts.quiz.questionCount, choiceCount: opts.quiz.choiceCount });
  const size = PAPER_SIZES[paper];
  const doc = new PDFDocument({
    size: [size.w * MM, size.h * MM],
    margin: 0,
    autoFirstPage: false,
    info: { Title: `QuickGrade answer sheet — ${opts.quiz.title}`, Creator: 'QuickGrade' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const pages: (SheetStudentInfo | undefined)[] = opts.students?.length
    ? opts.students
    : Array.from({ length: Math.max(1, Math.min(opts.copies ?? 1, 500)) }, () => undefined);
  for (const student of pages) {
    doc.addPage({ size: [size.w * MM, size.h * MM], margin: 0 });
    drawPage(doc, layout, opts.quiz, paper, student);
  }
  doc.end();
  return done;
}

