import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { photograph, renderFilledSheet, type Mark } from '../tests/helpers/synthetic';

const shots = path.join('test-results', 'screens');
fs.mkdirSync(shots, { recursive: true });
const KEY = 'ABCDABCDABCDABCDABCD';

test('teacher completes the full grading workflow in the browser', async ({ page, request }) => {
  const email = `e2e${Date.now()}@school.test`;

  // 1. Register.
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Liza Soberano');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/School or organisation/).fill('Rizal National High School');
  await page.getByLabel(/^Password/).fill('ganda ng araw 2026');
  await page.getByLabel('Confirm password').fill('ganda ng araw 2026');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: /Hello, Liza/ })).toBeVisible();
  await page.screenshot({ path: `${shots}/01-dashboard-empty.png`, fullPage: true });

  // 2. Class + students.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Classes' }).click();
  await page.getByRole('button', { name: 'New class' }).click();
  await page.getByLabel('Class name').fill('Grade 8 Science');
  await page.getByLabel('Section').fill('Rizal');
  await page.getByRole('button', { name: 'Create class' }).click();
  await page.getByRole('link', { name: /Grade 8 Science – Rizal/ }).click();
  for (const [num, first, last] of [['1001', 'Ana', 'Santos'], ['1002', 'Ben', 'Reyes']]) {
    await page.getByRole('button', { name: 'New student' }).click();
    await page.getByLabel('First name').fill(first);
    await page.getByLabel('Last name').fill(last);
    await page.getByLabel('Student number').fill(num);
    await page.getByRole('button', { name: 'Add student' }).click();
    await expect(page.getByRole('link', { name: `${last}, ${first}` })).toBeVisible();
  }
  await page.screenshot({ path: `${shots}/02-class.png`, fullPage: true });

  // 3. Quiz with answer key via quick entry.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Quizzes' }).click();
  await page.getByRole('link', { name: 'New quiz' }).first().click();
  await page.getByLabel('Title').fill('Science 8 – Matter Quiz');
  await page.getByLabel('Subject').fill('Science');
  await page.getByRole('button', { name: '20', exact: true }).click();
  await expect(page.getByText(/issue.* to fix before grading/)).toBeVisible();
  await page.getByLabel('Quick key entry').fill(KEY);
  await page.getByRole('button', { name: 'Fill' }).click();
  await expect(page.getByText('The answer key is complete and ready for grading.')).toBeVisible();
  await page.getByRole('button', { name: 'Create quiz' }).click();
  await expect(page.getByText(/Sheet #\d+/).first()).toBeVisible();
  await page.screenshot({ path: `${shots}/03-quiz-editor.png`, fullPage: true });
  const quizId = Number(page.url().split('/').pop());
  const sheetCode = Number((await page.getByText(/Sheet #\d+/).first().textContent())!.match(/#(\d+)/)![1]);

  // 4. Printable sheet PDF.
  await page.getByRole('button', { name: 'Print sheets' }).click();
  const pdfHref = await page.getByRole('link', { name: 'Open PDF' }).getAttribute('href');
  const pdf = await page.request.get(pdfHref!);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();

  // 5. Fill and photograph a sheet (synthetic photo of the real PDF layout).
  const marks: Mark[] = KEY.split('').map((l, i) => ({ question: i + 1, choice: i === 4 ? 1 : 'ABCD'.indexOf(l), style: 'pencil' as const }));
  marks.push({ question: 7, choice: 0, style: 'pencil' }); // double mark on Q7 (key C)
  '1002'.split('').forEach((d, i) => marks.push({ idDigit: { column: i, digit: Number(d) }, style: 'pencil' }));
  const sheet = await renderFilledSheet({ questionCount: 20, choiceCount: 4, sheetCode, marks });
  const photo = await photograph(sheet.png, { rotate: -5, perspective: 0.5, dimSide: 0.6, shadow: 0.25, noise: 6 });
  const photoPath = path.join(os.tmpdir(), `qg-e2e-${Date.now()}.jpg`);
  fs.writeFileSync(photoPath, photo);

  // 6. Start a grading session and upload.
  await page.goto(`/scan?quizId=${quizId}`);
  await page.getByLabel('Class').selectOption({ label: 'Grade 8 Science – Rizal (2)' });
  await page.getByRole('button', { name: 'Start grading session' }).click();
  await expect(page.getByText('2 · Capture answer sheets')).toBeVisible();
  await page.screenshot({ path: `${shots}/04-scan.png`, fullPage: true });
  await page.locator('input[type=file]').setInputFiles(photoPath);

  // 7. Review: student matched, one flagged question.
  await expect(page.getByRole('heading', { name: 'Review scanned sheet' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/ID 1002 matched/)).toBeVisible();
  await expect(page.getByText('Answers · 1 flagged')).toBeVisible();
  const save = page.getByRole('button', { name: /Confirm & save result/ });
  await expect(save).toBeDisabled();
  await page.screenshot({ path: `${shots}/05-review.png`, fullPage: true });
  await page.getByRole('button', { name: 'Keep as shown' }).click();
  await expect(save).toBeEnabled();
  await save.click();

  // 8. Back on the scan page; open the results.
  await expect(page.getByText('1 / 2 graded')).toBeVisible();
  await page.getByRole('link', { name: 'Results & analytics' }).click();
  await expect(page.getByRole('link', { name: 'Reyes, Ben' })).toBeVisible();
  // 18 correct of 20: Q5 wrong, Q7 multiple → 90%.
  await expect(page.getByRole('cell', { name: '18/20' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '90%' })).toBeVisible();
  await page.screenshot({ path: `${shots}/06-session.png`, fullPage: true });
  await page.getByRole('tab', { name: 'Analytics' }).click();
  await expect(page.getByText('Percent correct by question')).toBeVisible();
  await page.screenshot({ path: `${shots}/07-analytics.png`, fullPage: true });
  await page.getByRole('tab', { name: 'AI insights' }).click();
  await expect(page.getByText('AI features are not configured')).toBeVisible();

  // 9. Correct an answer; score and audit trail update.
  await page.getByRole('tab', { name: /Results/ }).click();
  await page.getByRole('link', { name: 'Reyes, Ben' }).click();
  await page.getByRole('button', { name: 'Correct answers' }).click();
  await page.getByRole('radiogroup', { name: 'Answer for question 5' }).getByRole('radio', { name: 'A' }).click();
  await page.getByLabel('Reason (optional)').fill('Checked paper copy');
  await page.getByRole('button', { name: 'Save 1 change' }).click();
  await expect(page.getByText(/Corrected 1 answer\(s\): score 18 → 19/)).toBeVisible();
  await page.screenshot({ path: `${shots}/08-result.png`, fullPage: true });

  // 10. Records persist and are visible on the dashboard.
  await page.goto('/');
  await expect(page.getByText('Results graded')).toBeVisible();
  await page.screenshot({ path: `${shots}/09-dashboard.png`, fullPage: true });
  void request;
});
