import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Public URL of the app, used in password-reset links. */
  APP_URL: z.string().url().default('http://localhost:5173'),
  DATA_DIR: z.string().default('./data'),
  DATABASE_FILE: z.string().optional(),
  /** Set when served behind HTTPS (cookies get the Secure flag). Defaults to true in production. */
  COOKIE_SECURE: bool.optional(),
  TRUST_PROXY: bool.default(false),
  SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  MAX_UPLOAD_MB: z.coerce.number().min(1).max(40).default(15),

  // Email (password reset). When SMTP_HOST is unset, reset links are written to the server log instead.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('QuickGrade <no-reply@quickgrade.local>'),

  // AI (optional). Core scanning and grading never depend on it.
  AI_PROVIDER: z.enum(['anthropic', 'none']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-opus-5-5'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(120_000),
  AI_DAILY_REQUESTS_PER_TEACHER: z.coerce.number().int().min(0).max(10_000).default(40),
  AI_MONTHLY_BUDGET_USD: z.coerce.number().min(0).default(20),
  /** Price per million tokens used for cost estimates (defaults match claude-opus-5-5 list pricing). */
  AI_INPUT_USD_PER_MTOK: z.coerce.number().min(0).default(4),
  AI_OUTPUT_USD_PER_MTOK: z.coerce.number().min(0).default(20),
});

export type Config = z.infer<typeof schema> & {
  databaseFile: string;
  uploadsDir: string;
  cookieSecure: boolean;
  aiEnabled: boolean;
};

export function loadConfig(overrides: Record<string, string | undefined> = {}): Config {
  const parsed = schema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const c = parsed.data;
  const dataDir = path.resolve(c.DATA_DIR);
  return {
    ...c,
    databaseFile: c.DATABASE_FILE === ':memory:' ? ':memory:' : path.resolve(c.DATABASE_FILE ?? path.join(dataDir, 'quickgrade.db')),
    uploadsDir: path.join(dataDir, 'uploads'),
    cookieSecure: c.COOKIE_SECURE ?? c.NODE_ENV === 'production',
    aiEnabled: c.AI_PROVIDER === 'anthropic' && !!c.ANTHROPIC_API_KEY,
  };
}
