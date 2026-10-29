import PDFDocument from 'pdfkit';
import type { QuestionRow, QuizRow } from '../services/grading';
import { choiceLetter } from '../../../shared/grading';
import type { ItemStat, SummaryStats, Bin } from '../../../shared/analytics';

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function header(doc: PDFKit.PDFDocument, title: string, subtitle: string) {
  doc.fillColor('#1d4ed8').font('Helvetica-Bold').fontSize(11).text('QuickGrade', { continued: false });
  doc.moveDown(0.2);
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(16).text(title);
  doc.fillColor('#4b5563').font('Helvetica').fontSize(9.5).text(subtitle);
  doc.moveDown(0.8);
}

export function renderAnswerKeyPdf(quiz: QuizRow, questions: QuestionRow[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Answer key — ${quiz.title}` } });
  const done = collect(doc);
  header(doc, `Answer key: ${quiz.title}`, [quiz.subject, `${quiz.question_count} items`, `Sheet #${quiz.sheet_code}`, 'CONFIDENTIAL — teacher copy'].filter(Boolean).join('  ·  '));

  const cols = 4;
  const perCol = Math.ceil(questions.length / cols);
  const colW = (doc.page.width - 96) / cols;
  const top = doc.y;
  const rowH = 15;
  questions.forEach((q, i) => {
    const c = Math.floor(i / perCol);
    const r = i % perCol;
    const x = 48 + c * colW;
    const y = top + r * rowH;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text(`${q.number}.`, x, y, { width: 26, align: 'right' });
    if (q.excluded) {
      doc.font('Helvetica-Oblique').fillColor('#9ca3af').text('excluded', x + 32, y);
    } else {
      doc.font('Helvetica-Bold').fillColor('#047857').text(choiceLetter(q.correct_choice), x + 32, y);
      if (q.points !== 1) doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text(`${q.points} pt`, x + 48, y + 1.5);
    }
  });
  doc.y = top + perCol * rowH + 20;
  doc.x = 48;
  const total = questions.filter((q) => !q.excluded).reduce((a, q) => a + q.points, 0);
  doc.font('Helvetica').fontSize(9.5).fillColor('#374151');
  doc.text(`Total points: ${total}. Passing: ${quiz.pass_percent ?? 'teacher default'}%.${quiz.wrong_penalty ? ` Wrong-answer penalty: ${quiz.wrong_penalty} pt.` : ''}`);

  const withText = questions.filter((q) => q.prompt);
  if (withText.length) {
    doc.addPage();
    header(doc, 'Questions', quiz.title);
    for (const q of withText) {
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text(`${q.number}. ${q.prompt}`);
      const choices: string[] = q.choices_json ? JSON.parse(q.choices_json) : [];
      choices.forEach((c, i) => {
        doc.font(i === q.correct_choice ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(i === q.correct_choice ? '#047857' : '#374151').text(`   ${choiceLetter(i)}. ${c}`);
      });
      if (q.topic) doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#6b7280').text(`   Topic: ${q.topic}`);
      doc.moveDown(0.5);
    }
  }
  doc.end();
  return done;
}

export interface SessionReportInput {
  quizTitle: string;
  sessionName: string;
  className: string;
  heldOn: string | null;
  passPercent: number;
  stats: SummaryStats;
  passRate: number | null;
  distribution: Bin[];
  items: ItemStat[];
  students: { name: string; studentNumber: string; rawScore: number; totalPoints: number; percent: number; passed: boolean }[];
}

export function renderSessionReportPdf(r: SessionReportInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Results — ${r.sessionName}` } });
  const done = collect(doc);
  header(doc, r.sessionName, [r.quizTitle, r.className, r.heldOn, `Generated ${new Date().toISOString().slice(0, 10)}`].filter(Boolean).join('  ·  '));

  const fmt = (v: number | null) => (v === null ? '—' : `${v}%`);
  const stats: [string, string][] = [
    ['Results', String(r.stats.count)],
    ['Mean', fmt(r.stats.mean)],
    ['Median', fmt(r.stats.median)],
    ['Highest', fmt(r.stats.max)],
    ['Lowest', fmt(r.stats.min)],
    ['Std. deviation', r.stats.stdDev === null ? '—' : `${r.stats.stdDev} pts`],
    [`Pass rate (≥ ${r.passPercent}%)`, fmt(r.passRate)],
  ];
  const boxW = (doc.page.width - 96) / 4;
  const statsTop = doc.y;
  stats.forEach(([label, value], i) => {
    const x = 48 + (i % 4) * boxW;
    const y = statsTop + Math.floor(i / 4) * 38;
    doc.font('Helvetica').fontSize(8.5).fillColor('#6b7280').text(label, x, y, { width: boxW - 8 });
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#111827').text(value, x, y + 11, { width: boxW - 8 });
  });
  doc.y = statsTop + Math.ceil(stats.length / 4) * 38 + 10;
  doc.x = 48;

  // Distribution bars.
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('Score distribution (percent)');
  doc.moveDown(0.4);
  const maxCount = Math.max(1, ...r.distribution.map((b) => b.count));
  const chartTop = doc.y;
  const barW = (doc.page.width - 96) / r.distribution.length;
  r.distribution.forEach((b, i) => {
    const h = (b.count / maxCount) * 70;
    const x = 48 + i * barW;
    doc.rect(x + 3, chartTop + 70 - h, barW - 6, h).fill('#2563eb');
    doc.font('Helvetica').fontSize(7.5).fillColor('#374151').text(b.label, x, chartTop + 74, { width: barW, align: 'center' });
    if (b.count) doc.text(String(b.count), x, chartTop + 60 - h, { width: barW, align: 'center' });
  });
  doc.y = chartTop + 92;
  doc.x = 48;

  // Most-missed questions.
  const missed = r.items.filter((i) => i.percentCorrect !== null).sort((a, b) => (a.percentCorrect ?? 0) - (b.percentCorrect ?? 0)).slice(0, 10);
  if (missed.length) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('Most-missed questions');
    doc.moveDown(0.3);
    for (const it of missed) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#374151')
        .text(
          `Q${it.number}: ${it.percentCorrect}% correct · key ${choiceLetter(it.correctChoice)}${it.topDistractor !== null ? ` · most common wrong answer ${choiceLetter(it.topDistractor)} (${it.choiceCounts[it.topDistractor]})` : ''}${it.topic ? ` · ${it.topic}` : ''}`,
        );
    }
    doc.moveDown(0.8);
  }

  // Student table.
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('Results by student');
  doc.moveDown(0.3);
  const cols = [
    { label: 'Student', w: 210 },
    { label: 'ID', w: 70 },
    { label: 'Score', w: 80 },
    { label: 'Percent', w: 70 },
    { label: 'Status', w: 60 },
  ];
  const drawRow = (vals: string[], bold = false) => {
    if (doc.y > doc.page.height - 70) doc.addPage();
    const y = doc.y;
    let x = 48;
    vals.forEach((v, i) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#111827').text(v, x, y, { width: cols[i].w - 6, lineBreak: false, ellipsis: true });
      x += cols[i].w;
    });
    doc.y = y + 14;
  };
  drawRow(cols.map((c) => c.label), true);
  for (const s of r.students) drawRow([s.name, s.studentNumber, `${s.rawScore}/${s.totalPoints}`, `${s.percent}%`, s.passed ? 'Passed' : 'Below']);
  doc.end();
  return done;
}
