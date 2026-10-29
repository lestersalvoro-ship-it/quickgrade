import { expect, test } from '@playwright/test';
import fs from 'node:fs';

test('mobile layout: navigation and no horizontal overflow', async ({ page }) => {
  fs.mkdirSync('test-results/screens', { recursive: true });
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Mobile Teacher');
  await page.getByLabel('Email').fill(`m${Date.now()}@school.test`);
  await page.getByLabel(/^Password/).fill('mobile pass 123');
  await page.getByLabel('Confirm password').fill('mobile pass 123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: /Hello, Mobile/ })).toBeVisible();
  for (const p of ['/', '/quizzes/new', '/scan', '/results', '/students', '/ai', '/settings']) {
    await page.goto(p);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal overflow on ${p}`).toBeLessThanOrEqual(1);
  }
  await page.goto('/quizzes/new');
  await page.screenshot({ path: 'test-results/screens/m-quiz.png', fullPage: true });
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'AI Assistant' })).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/m-menu.png' });
});
