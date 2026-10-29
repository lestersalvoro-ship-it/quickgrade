import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app';
import { AppError, parse, requireUser, type AuthUser } from '../http';
import { dummyPasswordHash, hashPassword, passwordProblem, passwordRules, randomToken, sha256, verifyPassword } from '../auth/password';
import { audit } from '../services/support';

export const SESSION_COOKIE = 'qg_session';

interface UserRow {
  id: number;
  email: string;
  full_name: string;
  school_name: string | null;
  default_pass_percent: number;
  image_retention_days: number;
  password_hash: string;
}

export function publicUser(u: AuthUser) {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    schoolName: u.schoolName,
    defaultPassPercent: u.defaultPassPercent,
    imageRetentionDays: u.imageRetentionDays,
  };
}

/** Resolves the session cookie into request.user. */
export function authHook(ctx: Ctx) {
  const find = ctx.db.prepare(
    `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, u.id, u.email, u.full_name, u.school_name, u.default_pass_percent, u.image_retention_days
     FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  );
  const touch = ctx.db.prepare('UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?');
  return async (req: FastifyRequest) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token || token.length > 200) return;
    const row = find.get(sha256(token)) as
      | (Omit<UserRow, 'password_hash'> & { session_id: number; expires_at: string; last_seen_at: string })
      | undefined;
    if (!row || row.expires_at < new Date().toISOString()) return;
    req.user = {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      schoolName: row.school_name,
      defaultPassPercent: row.default_pass_percent,
      imageRetentionDays: row.image_retention_days,
      sessionId: row.session_id,
    };
    // Sliding expiry, written at most once an hour.
    if (Date.now() - Date.parse(row.last_seen_at) > 3600_000) {
      const exp = new Date(Date.now() + ctx.config.SESSION_DAYS * 86400_000).toISOString();
      touch.run(new Date().toISOString(), exp, row.session_id);
    }
  };
}

function startSession(ctx: Ctx, reply: FastifyReply, req: FastifyRequest, userId: number) {
  const token = randomToken();
  const expires = new Date(Date.now() + ctx.config.SESSION_DAYS * 86400_000);
  ctx.db
    .prepare('INSERT INTO auth_sessions (user_id, token_hash, user_agent, expires_at) VALUES (?, ?, ?, ?)')
    .run(userId, sha256(token), (req.headers['user-agent'] ?? '').slice(0, 200), expires.toISOString());
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.cookieSecure,
    expires,
  });
}

const email = z.string().trim().toLowerCase().max(200).email('Enter a valid email address.');
const password = z.string().min(1, 'Required').max(passwordRules.max);

const authLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export async function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.post('/auth/register', { config: authLimit }, async (req, reply) => {
    const body = parse(
      z.object({
        email,
        password,
        fullName: z.string().trim().min(1, 'Enter your name.').max(120),
        schoolName: z.string().trim().max(160).optional(),
      }),
      req.body,
    );
    const problem = passwordProblem(body.password, body.email);
    if (problem) throw new AppError(400, 'WEAK_PASSWORD', problem);
    const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(body.email);
    if (exists) throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists. Try signing in or resetting your password.');
    const hash = await hashPassword(body.password);
    const info = db
      .prepare('INSERT INTO users (email, password_hash, full_name, school_name) VALUES (?, ?, ?, ?)')
      .run(body.email, hash, body.fullName, body.schoolName || null);
    const userId = Number(info.lastInsertRowid);
    audit(db, userId, 'user', userId, 'register', 'Account created');
    startSession(ctx, reply, req, userId);
    return reply.status(201).send({ user: { id: userId, email: body.email, fullName: body.fullName, schoolName: body.schoolName || null, defaultPassPercent: 75, imageRetentionDays: 30 } });
  });

  app.post('/auth/login', { config: authLimit }, async (req, reply) => {
    const body = parse(z.object({ email, password }), req.body);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(body.email) as UserRow | undefined;
    const ok = await verifyPassword(body.password, user?.password_hash ?? (await dummyPasswordHash()));
    if (!user || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
    startSession(ctx, reply, req, user.id);
    return {
      user: { id: user.id, email: user.email, fullName: user.full_name, schoolName: user.school_name, defaultPassPercent: user.default_pass_percent, imageRetentionDays: user.image_retention_days },
    };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.user) db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(req.user.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', async (req) => ({ user: publicUser(requireUser(req)) }));

  app.post('/auth/forgot-password', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req) => {
    const body = parse(z.object({ email }), req.body);
    const user = db.prepare('SELECT id, email, full_name FROM users WHERE email = ?').get(body.email) as { id: number; email: string; full_name: string } | undefined;
    if (user) {
      const token = randomToken();
      const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(new Date().toISOString(), user.id);
      db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(user.id, sha256(token), expires);
      const link = `${ctx.config.APP_URL.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
      await ctx.mailer
        .send(
          user.email,
          'Reset your QuickGrade password',
          `Hello ${user.full_name},\n\nUse this link within one hour to choose a new QuickGrade password:\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
        )
        .catch((e) => req.log.error(e, 'failed to send reset email'));
    }
    // Same response whether or not the account exists (no account enumeration).
    return { ok: true, emailConfigured: ctx.mailer.configured };
  });

  app.post('/auth/reset-password', { config: authLimit }, async (req) => {
    const body = parse(z.object({ token: z.string().min(10).max(200), password }), req.body);
    const row = db
      .prepare(
        `SELECT r.id, r.user_id, r.expires_at, r.used_at, u.email FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?`,
      )
      .get(sha256(body.token)) as { id: number; user_id: number; expires_at: string; used_at: string | null; email: string } | undefined;
    if (!row || row.used_at || row.expires_at < new Date().toISOString()) {
      throw new AppError(400, 'INVALID_TOKEN', 'This reset link is invalid or has expired. Request a new one.');
    }
    const problem = passwordProblem(body.password, row.email);
    if (problem) throw new AppError(400, 'WEAK_PASSWORD', problem);
    const hash = await hashPassword(body.password);
    db.transaction(() => {
      db.prepare(`UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(hash, row.user_id);
      db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
      db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(row.user_id);
      audit(db, row.user_id, 'user', row.user_id, 'password_reset', 'Password reset via email link');
    })();
    return { ok: true };
  });
}
