/**
 * Writes sample material to ./samples for trying the scanner without printing:
 *   - blank answer-sheet PDFs (20, 50, 100 items)
 *   - simulated phone photos of filled sheets for a quiz with the given sheet code
 * Usage: npm run sample-sheets -- <sheetCode> [questionCount] [choiceCount] [studentNumber]
 * (Find the sheet code on the quiz page, e.g. "Sheet #302684".) Requires poppler's pdftoppm.
 */
import fs from 'node:fs';
import { renderAnswerSheetPdf } from '../server/src/pdf/answerSheet';
import { photograph, renderFilledSheet, rng, type Mark } from '../tests/helpers/synthetic';

const [code = '1', n = '20', c = '4', student = '1001'] = process.argv.slice(2);
const sheetCode = Number(code);
const questionCount = Number(n);
const choiceCount = Number(c);
fs.mkdirSync('samples', { recursive: true });

for (const len of [20, 50, 100]) {
  const pdf = await renderAnswerSheetPdf({ quiz: { title: `Sample ${len}-item sheet`, subject: 'Sample', questionCount: len, choiceCount: 4, sheetCode }, paper: 'A4' });
  fs.writeFileSync(`samples/blank-${len}.pdf`, pdf);
}

const r = rng(sheetCode);
const marks: Mark[] = [];
const answers: string[] = [];
for (let q = 1; q <= questionCount; q++) {
  const ch = Math.floor(r() * choiceCount);
  answers.push('ABCDE'[ch]);
  marks.push({ question: q, choice: ch, style: 'pencil' });
}
student.split('').forEach((d, i) => marks.push({ idDigit: { column: i, digit: Number(d) }, style: 'pencil' }));
const sheet = await renderFilledSheet({ questionCount, choiceCount, sheetCode, marks });
fs.writeFileSync('samples/filled-flat.png', sheet.png);
fs.writeFileSync('samples/photo-tilted.jpg', await photograph(sheet.png, { rotate: 6, perspective: 0.6, dimSide: 0.6, shadow: 0.3, noise: 6 }));
fs.writeFileSync('samples/photo-upside-down.jpg', await photograph(sheet.png, { rotate: 180, perspective: 0.3 }));
fs.writeFileSync('samples/answers.txt', `Marked answers (student ${student}): ${answers.join('')}\n`);
console.log(`Wrote samples/ (sheet code ${sheetCode}, ${questionCount} items). Marked answers: ${answers.join('')}`);
