import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app';
import { parse, requireUser } from '../http';

export async function dashboardRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/dashboard', async (req) => {
    const user = requireUser(req);
    const one = <T>(sql: string) => db.prepare(sql).get({ uid: user.id }) as T;
    const counts = one<{ quizzes: number; classes: number; students: number; sessions: number; results: number; pending: number }>(
      `SELECT
        (SELECT COUNT(*) FROM quizzes WHERE teacher_id = @uid AND archived_at IS NULL) AS quizzes,
        (SELECT COUNT(*) FROM classes WHERE teacher_id = @uid AND archived_at IS NULL) AS classes,
        (SELECT COUNT(*) FROM students WHERE teacher_id = @uid AND archived_at IS NULL) AS students,
        (SELECT COUNT(*) FROM grading_sessions WHERE teacher_id = @uid AND archived_at IS NULL) AS sessions,
        (SELECT COUNT(*) FROM submissions s JOIN grading_sessions g ON g.id = s.session_id WHERE g.teacher_id = @uid) AS results,
        (SELECT COUNT(*) FROM scans WHERE teacher_id = @uid AND status = 'pending') AS pending`,
    );
    // Pass/fail uses each quiz's own threshold (or the teacher default).
    const agg = one<{ n: number; mean: number | null; passed: number }>(
      `SELECT COUNT(*) AS n, AVG(s.percent) AS mean,
              SUM(CASE WHEN s.percent >= COALESCE(q.pass_percent, u.default_pass_percent) THEN 1 ELSE 0 END) AS passed
       FROM submissions s JOIN grading_sessions g ON g.id = s.session_id JOIN quizzes q ON q.id = g.quiz_id JOIN users u ON u.id = g.teacher_id
       WHERE g.teacher_id = @uid`,
    );
    const recentSessions = db
      .prepare(
        `SELECT g.id, g.name, g.held_on, g.created_at, q.title AS quiz_title, c.name AS class_name, c.section AS class_section,
           COUNT(s.id) AS n, AVG(s.percent) AS mean,
           SUM(CASE WHEN s.percent >= COALESCE(q.pass_percent, u.default_pass_percent) THEN 1 ELSE 0 END) AS passed
         FROM grading_sessions g JOIN quizzes q ON q.id = g.quiz_id JOIN classes c ON c.id = g.class_id JOIN users u ON u.id = g.teacher_id
         LEFT JOIN submissions s ON s.session_id = g.id
         WHERE g.teacher_id = ? AND g.archived_at IS NULL
         GROUP BY g.id ORDER BY COALESCE(g.held_on, substr(g.created_at,1,10)) DESC, g.id DESC LIMIT 10`,
      )
      .all(user.id) as {
      id: number;
      name: string;
      held_on: string | null;
      created_at: string;
      quiz_title: string;
      class_name: string;
      class_section: string | null;
      n: number;
      mean: number | null;
      passed: number | null;
    }[];
    const activity = db
      .prepare('SELECT entity_type, entity_id, action, summary, created_at FROM audit_logs WHERE teacher_id = ? ORDER BY id DESC LIMIT 12')
      .all(user.id) as { entity_type: string; entity_id: number | null; action: string; summary: string; created_at: string }[];
    const r2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
    return {
      counts,
      overall: { results: agg.n, meanPercent: r2(agg.mean), passRate: agg.n ? r2((agg.passed / agg.n) * 100) : null },
      recentSessions: recentSessions.map((s) => ({
        id: s.id,
        name: s.name,
        heldOn: s.held_on,
        createdAt: s.created_at,
        quizTitle: s.quiz_title,
        className: `${s.class_name}${s.class_section ? ' – ' + s.class_section : ''}`,
        submissionCount: s.n,
        meanPercent: r2(s.mean),
        passRate: s.n ? r2(((s.passed ?? 0) / s.n) * 100) : null,
      })),
      activity: activity.map((a) => ({ entityType: a.entity_type, entityId: a.entity_id, action: a.action, summary: a.summary, at: a.created_at })),
    };
  });

  app.get('/activity', async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    const rows = db
      .prepare('SELECT entity_type, entity_id, action, summary, created_at FROM audit_logs WHERE teacher_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(user.id, q.pageSize, (q.page - 1) * q.pageSize) as { entity_type: string; entity_id: number | null; action: string; summary: string; created_at: string }[];
    const total = (db.prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE teacher_id = ?').get(user.id) as { n: number }).n;
    return { items: rows.map((a) => ({ entityType: a.entity_type, entityId: a.entity_id, action: a.action, summary: a.summary, at: a.created_at })), total, page: q.page, pageSize: q.pageSize };
  });
}
