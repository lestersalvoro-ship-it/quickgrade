import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app';
import { AppError, parse, requireUser } from '../http';
import { hashPassword, passwordProblem, verifyPassword } from '../auth/password';
import { audit } from '../services/support';
import { SESSION_COOKIE } from './auth';

export async function settingsRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.put('/settings/profile', async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        fullName: z.string().trim().min(1).max(120),
        schoolName: z.string().trim().max(160).nullish(),
        defaultPassPercent: z.number().min(0).max(100),
        imageRetentionDays: z.number().int().min(0).max(3650),
      }),
      req.body,
    );
    db.prepare(
      `UPDATE users SET full_name = ?, school_name = ?, default_pass_percent = ?, image_retention_days = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    ).run(body.fullName, body.schoolName || null, body.defaultPassPercent, body.imageRetentionDays, user.id);
    // Keep the stored pass flag in sync for quizzes that use the default threshold.
    db.prepare(
      `UPDATE submissions SET passed = (percent >= ?) WHERE session_id IN (
         SELECT g.id FROM grading_sessions g JOIN quizzes q ON q.id = g.quiz_id WHERE g.teacher_id = ? AND q.pass_percent IS NULL)`,
    ).run(body.defaultPassPercent, user.id);
    audit(db, user.id, 'user', user.id, 'update_profile', 'Updated profile and settings', body);
    return { user: { id: user.id, email: user.email, ...body, schoolName: body.schoolName || null } };
  });

  app.post('/settings/password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) }), req.body);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
    if (!(await verifyPassword(body.currentPassword, row.password_hash))) throw new AppError(400, 'INVALID_CREDENTIALS', 'Current password is incorrect.');
    const problem = passwordProblem(body.newPassword, user.email);
    if (problem) throw new AppError(400, 'WEAK_PASSWORD', problem);
    const hash = await hashPassword(body.newPassword);
    db.transaction(() => {
      db.prepare(`UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(hash, user.id);
      // Sign out every other device.
      db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND id <> ?').run(user.id, user.sessionId);
      audit(db, user.id, 'user', user.id, 'change_password', 'Changed password; other sessions signed out');
    })();
    return { ok: true };
  });

  /** Full export of the teacher's records (data portability). */
  app.get('/settings/export', async (req, reply) => {
    const user = requireUser(req);
    const q = (sql: string, ...params: unknown[]) => db.prepare(sql).all(...params);
    const data = {
      exportedAt: new Date().toISOString(),
      account: { email: user.email, fullName: user.fullName, schoolName: user.schoolName },
      classes: q('SELECT * FROM classes WHERE teacher_id = ?', user.id),
      students: q('SELECT * FROM students WHERE teacher_id = ?', user.id),
      enrollments: q('SELECT e.* FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE c.teacher_id = ?', user.id),
      quizzes: q('SELECT * FROM quizzes WHERE teacher_id = ?', user.id),
      questions: q('SELECT qq.* FROM questions qq JOIN quizzes z ON z.id = qq.quiz_id WHERE z.teacher_id = ?', user.id),
      gradingSessions: q('SELECT * FROM grading_sessions WHERE teacher_id = ?', user.id),
      submissions: q('SELECT s.* FROM submissions s JOIN grading_sessions g ON g.id = s.session_id WHERE g.teacher_id = ?', user.id),
      responses: q(
        'SELECT r.* FROM responses r JOIN submissions s ON s.id = r.submission_id JOIN grading_sessions g ON g.id = s.session_id WHERE g.teacher_id = ?',
        user.id,
      ),
      auditLog: q('SELECT entity_type, entity_id, action, summary, created_at FROM audit_logs WHERE teacher_id = ? ORDER BY id', user.id),
    };
    return reply.header('content-disposition', 'attachment; filename="quickgrade-export.json"').send(data);
  });

  /** Permanently deletes the account and every record and image that belongs to it. */
  app.post('/settings/delete-account', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(z.object({ password: z.string().min(1).max(200), confirm: z.literal('DELETE') }), req.body);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
    if (!(await verifyPassword(body.password, row.password_hash))) throw new AppError(400, 'INVALID_CREDENTIALS', 'Password is incorrect.');
    db.transaction(() => {
      // Sessions restrict quiz/class deletion, so remove them first; everything else cascades from users.
      db.prepare('DELETE FROM grading_sessions WHERE teacher_id = ?').run(user.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    })();
    ctx.storage.removeTeacher(user.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
