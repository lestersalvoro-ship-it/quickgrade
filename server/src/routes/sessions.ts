import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { stringify } from 'csv-stringify/sync';
import type { Ctx } from '../app';
import type { DB } from '../db/index';
import { AppError, conflict, csvSafe, idParam, notFound, parse, reqText, requireUser, sendCsv, sendPdf } from '../http';
import { audit } from '../services/support';
import { loadQuestions, loadResponses, rulesFor, saveSubmission, teacherPassDefault, type QuizRow } from '../services/grading';
import { itemAnalysis, passRate, scoreDistribution, summarize, topicBreakdown } from '../../../shared/analytics';
import { choiceLetter } from '../../../shared/grading';
import { renderSessionReportPdf } from '../pdf/reports';
import { getOwnedQuiz } from './quizzes';
import { getOwnedClass } from './classes';
import { getOwnedStudent } from './students';

export interface SessionRow {
  id: number;
  teacher_id: number;
  quiz_id: number;
  class_id: number;
  name: string;
  held_on: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export function getOwnedSession(ctx: Ctx, teacherId: number, id: number): SessionRow {
  const row = ctx.db.prepare('SELECT * FROM grading_sessions WHERE id = ? AND teacher_id = ?').get(id, teacherId) as SessionRow | undefined;
  if (!row) throw notFound('Grading session');
  return row;
}

interface SubmissionListRow {
  id: number;
  student_id: number;
  first_name: string;
  last_name: string;
  student_number: string;
  raw_score: number;
  total_points: number;
  percent: number;
  correct_count: number;
  incorrect_count: number;
  blank_count: number;
  multiple_count: number;
  passed: number;
  source: string;
  teacher_edits: number;
  created_at: string;
  updated_at: string;
}

export function sessionSubmissions(db: DB, sessionId: number): SubmissionListRow[] {
  return db
    .prepare(
      `SELECT sub.*, s.first_name, s.last_name, s.student_number FROM submissions sub JOIN students s ON s.id = sub.student_id
       WHERE sub.session_id = ? ORDER BY s.last_name COLLATE NOCASE, s.first_name COLLATE NOCASE`,
    )
    .all(sessionId) as SubmissionListRow[];
}

/** Full analytics for one grading session, computed from saved records only. */
export function sessionAnalytics(db: DB, session: SessionRow, quiz: QuizRow) {
  const questions = loadQuestions(db, quiz.id);
  const rules = rulesFor(quiz, teacherPassDefault(db, session.teacher_id));
  const subs = sessionSubmissions(db, session.id);
  const percents = subs.map((s) => s.percent);
  const items = itemAnalysis(
    questions.map((q) => ({ number: q.number, correctChoice: q.correct_choice, excluded: !!q.excluded, topic: q.topic })),
    quiz.choice_count,
    subs.map((s) => ({ percent: s.percent, responses: loadResponses(db, s.id) })),
  );
  return {
    passPercent: rules.passPercent,
    stats: summarize(percents),
    rawStats: summarize(subs.map((s) => s.raw_score)),
    totalPoints: subs[0]?.total_points ?? questions.filter((q) => !q.excluded).reduce((a, q) => a + q.points, 0),
    passRate: passRate(percents, rules.passPercent),
    passedCount: percents.filter((p) => p >= rules.passPercent).length,
    distribution: scoreDistribution(percents),
    items,
    topics: topicBreakdown(items),
    hasTopics: questions.some((q) => q.topic),
  };
}

const sessionBody = z.object({
  name: reqText(160),
  heldOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .nullish()
    .transform((v) => v || null),
});

function sessionListItem(db: DB, row: SessionRow & { quiz_title: string; class_name: string; class_section: string | null; question_count: number }) {
  const agg = db
    .prepare('SELECT COUNT(*) AS n, AVG(percent) AS mean FROM submissions WHERE session_id = ?')
    .get(row.id) as { n: number; mean: number | null };
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(row.quiz_id) as QuizRow;
  const pass = rulesFor(quiz, teacherPassDefault(db, row.teacher_id)).passPercent;
  const passed = (db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE session_id = ? AND percent >= ?').get(row.id, pass) as { n: number }).n;
  const pending = (db.prepare(`SELECT COUNT(*) AS n FROM scans WHERE session_id = ? AND status = 'pending'`).get(row.id) as { n: number }).n;
  return {
    id: row.id,
    name: row.name,
    heldOn: row.held_on,
    archived: !!row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    quiz: { id: row.quiz_id, title: row.quiz_title, questionCount: row.question_count },
    class: { id: row.class_id, name: row.class_name, section: row.class_section },
    submissionCount: agg.n,
    meanPercent: agg.mean === null ? null : Math.round(agg.mean * 100) / 100,
    passRate: agg.n ? Math.round((passed / agg.n) * 10000) / 100 : null,
    passPercent: pass,
    pendingScans: pending,
  };
}

export async function sessionRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  const listSql = `SELECT g.*, q.title AS quiz_title, q.question_count, c.name AS class_name, c.section AS class_section
    FROM grading_sessions g JOIN quizzes q ON q.id = g.quiz_id JOIN classes c ON c.id = g.class_id`;

  app.get('/sessions', async (req) => {
    const user = requireUser(req);
    const q = parse(
      z.object({
        q: z.string().trim().max(100).optional(),
        quizId: z.coerce.number().int().positive().optional(),
        classId: z.coerce.number().int().positive().optional(),
        archived: z.enum(['0', '1', 'all']).default('0'),
        sort: z.enum(['recent', 'oldest', 'name']).default('recent'),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      }),
      req.query,
    );
    const where = ['g.teacher_id = ?'];
    const params: unknown[] = [user.id];
    if (q.archived === '0') where.push('g.archived_at IS NULL');
    if (q.archived === '1') where.push('g.archived_at IS NOT NULL');
    if (q.quizId) where.push('g.quiz_id = ?'), params.push(q.quizId);
    if (q.classId) where.push('g.class_id = ?'), params.push(q.classId);
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      where.push(`(g.name LIKE ? ESCAPE '\\' OR q.title LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')`);
      params.push(like, like, like);
    }
    const order = q.sort === 'name' ? 'g.name COLLATE NOCASE' : q.sort === 'oldest' ? 'COALESCE(g.held_on, g.created_at), g.id' : 'COALESCE(g.held_on, substr(g.created_at,1,10)) DESC, g.id DESC';
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM grading_sessions g JOIN quizzes q ON q.id = g.quiz_id JOIN classes c ON c.id = g.class_id WHERE ${where.join(' AND ')}`).get(...params) as { n: number }).n;
    const rows = db.prepare(`${listSql} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Parameters<typeof sessionListItem>[1][];
    return { sessions: rows.map((r) => sessionListItem(db, r)), total, page: q.page, pageSize: q.pageSize };
  });

  app.post('/sessions', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(sessionBody.extend({ quizId: z.number().int().positive(), classId: z.number().int().positive() }), req.body);
    const quiz = getOwnedQuiz(ctx, user.id, body.quizId);
    const cls = getOwnedClass(ctx, user.id, body.classId);
    if (quiz.archived_at) throw new AppError(400, 'QUIZ_ARCHIVED', 'Restore the quiz before grading with it.');
    if (cls.archived_at) throw new AppError(400, 'CLASS_ARCHIVED', 'Restore the class before grading it.');
    const info = db
      .prepare('INSERT INTO grading_sessions (teacher_id, quiz_id, class_id, name, held_on) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, quiz.id, cls.id, body.name, body.heldOn);
    const id = Number(info.lastInsertRowid);
    audit(db, user.id, 'session', id, 'create', `Started grading session "${body.name}" for ${cls.name} with quiz "${quiz.title}"`);
    const row = db.prepare(`${listSql} WHERE g.id = ?`).get(id) as Parameters<typeof sessionListItem>[1];
    return reply.status(201).send({ session: sessionListItem(db, row) });
  });

  app.get('/sessions/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    getOwnedSession(ctx, user.id, id);
    const row = db.prepare(`${listSql} WHERE g.id = ?`).get(id) as Parameters<typeof sessionListItem>[1];
    const subs = sessionSubmissions(db, id);
    const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(row.quiz_id) as QuizRow;
    const pass = rulesFor(quiz, user.defaultPassPercent).passPercent;
    const missing = db
      .prepare(
        `SELECT s.id, s.first_name, s.last_name, s.student_number FROM enrollments e JOIN students s ON s.id = e.student_id
         WHERE e.class_id = ? AND s.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM submissions x WHERE x.session_id = ? AND x.student_id = s.id)
         ORDER BY s.last_name COLLATE NOCASE, s.first_name COLLATE NOCASE`,
      )
      .all(row.class_id, id) as { id: number; first_name: string; last_name: string; student_number: string }[];
    const pendingScans = db
      .prepare(`SELECT id, created_at, detected_student_number, flagged_count FROM scans WHERE session_id = ? AND status = 'pending' ORDER BY id`)
      .all(id) as { id: number; created_at: string; detected_student_number: string | null; flagged_count: number }[];
    return {
      session: sessionListItem(db, row),
      submissions: subs.map((s) => ({
        id: s.id,
        student: { id: s.student_id, firstName: s.first_name, lastName: s.last_name, studentNumber: s.student_number },
        rawScore: s.raw_score,
        totalPoints: s.total_points,
        percent: s.percent,
        correct: s.correct_count,
        incorrect: s.incorrect_count,
        blank: s.blank_count,
        multiple: s.multiple_count,
        passed: s.percent >= pass,
        source: s.source,
        teacherEdits: s.teacher_edits,
        gradedAt: s.created_at,
        updatedAt: s.updated_at,
      })),
      missingStudents: missing.map((m) => ({ id: m.id, firstName: m.first_name, lastName: m.last_name, studentNumber: m.student_number })),
      pendingScans: pendingScans.map((p) => ({ id: p.id, createdAt: p.created_at, detectedStudentNumber: p.detected_student_number, flaggedCount: p.flagged_count })),
    };
  });

  app.put('/sessions/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    getOwnedSession(ctx, user.id, id);
    const body = parse(sessionBody, req.body);
    db.prepare(`UPDATE grading_sessions SET name = ?, held_on = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(body.name, body.heldOn, id);
    audit(db, user.id, 'session', id, 'update', `Renamed grading session to "${body.name}"`);
    return { ok: true };
  });

  app.post('/sessions/:id/archive', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const s = getOwnedSession(ctx, user.id, id);
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    db.prepare(`UPDATE grading_sessions SET archived_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(archived ? new Date().toISOString() : null, id);
    audit(db, user.id, 'session', id, archived ? 'archive' : 'restore', `${archived ? 'Archived' : 'Restored'} grading session "${s.name}"`);
    return { ok: true };
  });

  app.delete('/sessions/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const s = getOwnedSession(ctx, user.id, id);
    const scans = db.prepare('SELECT image_path, rectified_path FROM scans WHERE session_id = ?').all(id) as { image_path: string | null; rectified_path: string | null }[];
    const n = (db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE session_id = ?').get(id) as { n: number }).n;
    db.transaction(() => {
      db.prepare('DELETE FROM grading_sessions WHERE id = ?').run(id);
      audit(db, user.id, 'session', id, 'delete', `Deleted grading session "${s.name}" with ${n} result(s)`);
    })();
    for (const sc of scans) {
      ctx.storage.remove(sc.image_path);
      ctx.storage.remove(sc.rectified_path);
    }
    return { ok: true };
  });

  app.get('/sessions/:id/analytics', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const s = getOwnedSession(ctx, user.id, id);
    const quiz = getOwnedQuiz(ctx, user.id, s.quiz_id);
    return { analytics: sessionAnalytics(db, s, quiz), choiceCount: quiz.choice_count };
  });

  /** Manual entry (e.g. absent scanner, damaged sheet). Goes through the same grading engine. */
  app.post('/sessions/:id/manual', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const s = getOwnedSession(ctx, user.id, id);
    const body = parse(
      z.object({
        studentId: z.number().int().positive(),
        replaceExisting: z.boolean().default(false),
        responses: z
          .array(
            z.object({
              number: z.number().int().min(1).max(100),
              status: z.enum(['answered', 'blank', 'multiple']),
              choice: z.number().int().min(0).max(4).nullable(),
              marked: z.array(z.number().int().min(0).max(4)).max(5).optional(),
            }),
          )
          .min(1)
          .max(100),
      }),
      req.body,
    );
    const quiz = getOwnedQuiz(ctx, user.id, s.quiz_id);
    getOwnedStudent(ctx, user.id, body.studentId);
    const enrolled = db.prepare('SELECT 1 FROM enrollments WHERE class_id = ? AND student_id = ?').get(s.class_id, body.studentId);
    if (!enrolled) throw new AppError(400, 'NOT_ENROLLED', 'This student is not enrolled in the session’s class.');
    const res = saveSubmission(db, quiz, loadQuestions(db, quiz.id), {
      teacherId: user.id,
      sessionId: id,
      studentId: body.studentId,
      source: 'manual',
      responses: body.responses.map((r) => ({ ...r, scannerStatus: null, teacherOverride: false })),
      replaceExisting: body.replaceExisting,
    });
    return reply.status(201).send({ submissionId: res.submissionId, grade: res.grade, replaced: res.replaced });
  });

  app.get('/sessions/:id/results.csv', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const s = getOwnedSession(ctx, user.id, id);
    const quiz = getOwnedQuiz(ctx, user.id, s.quiz_id);
    const pass = rulesFor(quiz, user.defaultPassPercent).passPercent;
    const { detail } = parse(z.object({ detail: z.enum(['0', '1']).default('1') }), req.query);
    const subs = sessionSubmissions(db, id);
    const qCols = detail === '1' ? Array.from({ length: quiz.question_count }, (_, i) => `q${i + 1}`) : [];
    const rows = subs.map((sub) => {
      const base: (string | number)[] = [
        csvSafe(sub.student_number),
        csvSafe(sub.last_name),
        csvSafe(sub.first_name),
        sub.raw_score,
        sub.total_points,
        sub.percent,
        sub.percent >= pass ? 'passed' : 'below',
        sub.correct_count,
        sub.incorrect_count,
        sub.blank_count,
        sub.multiple_count,
      ];
      if (detail === '1') {
        const resp = loadResponses(db, sub.id);
        for (const r of resp) base.push(r.status === 'answered' ? choiceLetter(r.choice) : r.status === 'multiple' ? 'MULTI' : '');
      }
      return base;
    });
    const csv = stringify(rows, {
      header: true,
      columns: ['student_number', 'last_name', 'first_name', 'score', 'total_points', 'percent', 'status', 'correct', 'incorrect', 'blank', 'multiple', ...qCols],
    });
    return sendCsv(reply, `${s.name}-results.csv`, csv);
  });

  app.get('/sessions/:id/item-analysis.csv', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const s = getOwnedSession(ctx, user.id, id);
    const quiz = getOwnedQuiz(ctx, user.id, s.quiz_id);
    const a = sessionAnalytics(db, s, quiz);
    const letters = Array.from({ length: quiz.choice_count }, (_, i) => `chose_${choiceLetter(i)}`);
    const rows = a.items.map((it) => [
      it.number,
      choiceLetter(it.correctChoice),
      it.excluded ? 'yes' : 'no',
      it.percentCorrect ?? '',
      it.discrimination ?? '',
      ...it.choiceCounts,
      it.blankCount,
      it.multipleCount,
      csvSafe(it.topic ?? ''),
    ]);
    const csv = stringify(rows, { header: true, columns: ['question', 'key', 'excluded', 'percent_correct', 'discrimination', ...letters, 'blank', 'multiple', 'topic'] });
    return sendCsv(reply, `${s.name}-item-analysis.csv`, csv);
  });

  app.get('/sessions/:id/report.pdf', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const s = getOwnedSession(ctx, user.id, id);
    const quiz = getOwnedQuiz(ctx, user.id, s.quiz_id);
    const cls = getOwnedClass(ctx, user.id, s.class_id);
    const a = sessionAnalytics(db, s, quiz);
    const pdf = await renderSessionReportPdf({
      quizTitle: quiz.title,
      sessionName: s.name,
      className: `${cls.name}${cls.section ? ' – ' + cls.section : ''}`,
      heldOn: s.held_on,
      passPercent: a.passPercent,
      stats: a.stats,
      passRate: a.passRate,
      distribution: a.distribution,
      items: a.items,
      students: sessionSubmissions(db, id).map((x) => ({
        name: `${x.last_name}, ${x.first_name}`,
        studentNumber: x.student_number,
        rawScore: x.raw_score,
        totalPoints: x.total_points,
        percent: x.percent,
        passed: x.percent >= a.passPercent,
      })),
    });
    return sendPdf(reply, `${s.name}-report.pdf`, pdf, true);
  });

  /** Compare summary statistics across grading sessions. */
  app.get('/analytics/compare', async (req) => {
    const user = requireUser(req);
    const { ids } = parse(z.object({ ids: z.string().regex(/^\d+(,\d+){0,11}$/, 'Select up to 12 sessions.') }), req.query);
    const sessionIds = [...new Set(ids.split(',').map(Number))];
    return {
      sessions: sessionIds.map((sid) => {
        const s = getOwnedSession(ctx, user.id, sid);
        const quiz = getOwnedQuiz(ctx, user.id, s.quiz_id);
        const cls = getOwnedClass(ctx, user.id, s.class_id);
        const subs = sessionSubmissions(db, sid);
        const pass = rulesFor(quiz, user.defaultPassPercent).passPercent;
        const percents = subs.map((x) => x.percent);
        return {
          id: s.id,
          name: s.name,
          heldOn: s.held_on,
          createdAt: s.created_at,
          quizTitle: quiz.title,
          className: `${cls.name}${cls.section ? ' – ' + cls.section : ''}`,
          passPercent: pass,
          stats: summarize(percents),
          passRate: passRate(percents, pass),
        };
      }),
    };
  });

}
