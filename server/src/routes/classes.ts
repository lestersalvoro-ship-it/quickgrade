import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { stringify } from 'csv-stringify/sync';
import type { Ctx } from '../app';
import { conflict, csvSafe, idParam, notFound, optText, parse, reqText, requireUser, sendCsv } from '../http';
import { audit } from '../services/support';

export interface ClassRow {
  id: number;
  teacher_id: number;
  name: string;
  section: string | null;
  subject: string | null;
  school_year: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export const classDto = (c: ClassRow & { student_count?: number; session_count?: number }) => ({
  id: c.id,
  name: c.name,
  section: c.section,
  subject: c.subject,
  schoolYear: c.school_year,
  archived: !!c.archived_at,
  archivedAt: c.archived_at,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
  studentCount: c.student_count ?? 0,
  sessionCount: c.session_count ?? 0,
});

const classBody = z.object({
  name: reqText(100),
  section: optText(60),
  subject: optText(100),
  schoolYear: optText(20),
});

export function getOwnedClass(ctx: Ctx, teacherId: number, id: number): ClassRow {
  const row = ctx.db.prepare('SELECT * FROM classes WHERE id = ? AND teacher_id = ?').get(id, teacherId) as ClassRow | undefined;
  if (!row) throw notFound('Class');
  return row;
}

export async function classRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  const duplicateCheck = (teacherId: number, name: string, section: string | null, exceptId = 0) => {
    const dup = db
      .prepare(
        `SELECT id FROM classes WHERE teacher_id = ? AND name = ? COLLATE NOCASE AND ifnull(section,'') = ? COLLATE NOCASE AND archived_at IS NULL AND id <> ?`,
      )
      .get(teacherId, name, section ?? '', exceptId);
    if (dup) throw conflict('You already have an active class with this name and section.');
  };

  app.get('/classes', async (req) => {
    const user = requireUser(req);
    const { archived } = parse(z.object({ archived: z.enum(['0', '1', 'all']).default('0') }), req.query);
    const where = archived === 'all' ? '' : archived === '1' ? 'AND c.archived_at IS NOT NULL' : 'AND c.archived_at IS NULL';
    const rows = db
      .prepare(
        `SELECT c.*,
           (SELECT COUNT(*) FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.class_id = c.id AND s.archived_at IS NULL) AS student_count,
           (SELECT COUNT(*) FROM grading_sessions g WHERE g.class_id = c.id AND g.archived_at IS NULL) AS session_count
         FROM classes c WHERE c.teacher_id = ? ${where} ORDER BY c.archived_at IS NOT NULL, c.name COLLATE NOCASE, c.section`,
      )
      .all(user.id) as (ClassRow & { student_count: number; session_count: number })[];
    return { classes: rows.map(classDto) };
  });

  app.post('/classes', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(classBody, req.body);
    duplicateCheck(user.id, body.name, body.section);
    const info = db
      .prepare('INSERT INTO classes (teacher_id, name, section, subject, school_year) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, body.name, body.section, body.subject, body.schoolYear);
    const id = Number(info.lastInsertRowid);
    audit(db, user.id, 'class', id, 'create', `Created class ${body.name}${body.section ? ' – ' + body.section : ''}`);
    return reply.status(201).send({ class: classDto(getOwnedClass(ctx, user.id, id)) });
  });

  app.get('/classes/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const c = getOwnedClass(ctx, user.id, id);
    const students = db
      .prepare(
        `SELECT s.id, s.student_number, s.first_name, s.last_name, s.external_id, s.archived_at, e.enrolled_at
         FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.class_id = ? ORDER BY s.last_name COLLATE NOCASE, s.first_name COLLATE NOCASE`,
      )
      .all(id) as { id: number; student_number: string; first_name: string; last_name: string; external_id: string | null; archived_at: string | null; enrolled_at: string }[];
    const sessions = db
      .prepare(
        `SELECT g.id, g.name, g.held_on, g.created_at, q.title AS quiz_title,
          (SELECT COUNT(*) FROM submissions s WHERE s.session_id = g.id) AS submission_count,
          (SELECT AVG(percent) FROM submissions s WHERE s.session_id = g.id) AS mean_percent
         FROM grading_sessions g JOIN quizzes q ON q.id = g.quiz_id WHERE g.class_id = ? AND g.archived_at IS NULL ORDER BY g.created_at DESC`,
      )
      .all(id) as { id: number; name: string; held_on: string | null; created_at: string; quiz_title: string; submission_count: number; mean_percent: number | null }[];
    return {
      class: classDto({ ...c, student_count: students.filter((s) => !s.archived_at).length, session_count: sessions.length }),
      students: students.map((s) => ({
        id: s.id,
        studentNumber: s.student_number,
        firstName: s.first_name,
        lastName: s.last_name,
        externalId: s.external_id,
        archived: !!s.archived_at,
        enrolledAt: s.enrolled_at,
      })),
      sessions: sessions.map((g) => ({
        id: g.id,
        name: g.name,
        heldOn: g.held_on,
        createdAt: g.created_at,
        quizTitle: g.quiz_title,
        submissionCount: g.submission_count,
        meanPercent: g.mean_percent === null ? null : Math.round(g.mean_percent * 100) / 100,
      })),
    };
  });

  app.put('/classes/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const c = getOwnedClass(ctx, user.id, id);
    const body = parse(classBody, req.body);
    if (!c.archived_at) duplicateCheck(user.id, body.name, body.section, id);
    db.prepare(
      `UPDATE classes SET name = ?, section = ?, subject = ?, school_year = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    ).run(body.name, body.section, body.subject, body.schoolYear, id);
    audit(db, user.id, 'class', id, 'update', `Updated class ${body.name}`);
    return { class: classDto(getOwnedClass(ctx, user.id, id)) };
  });

  app.post('/classes/:id/archive', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const c = getOwnedClass(ctx, user.id, id);
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    if (!archived) duplicateCheck(user.id, c.name, c.section, id);
    db.prepare(`UPDATE classes SET archived_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(archived ? new Date().toISOString() : null, id);
    audit(db, user.id, 'class', id, archived ? 'archive' : 'restore', `${archived ? 'Archived' : 'Restored'} class ${c.name}`);
    return { class: classDto(getOwnedClass(ctx, user.id, id)) };
  });

  app.post('/classes/:id/enroll', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    getOwnedClass(ctx, user.id, id);
    const { studentIds } = parse(z.object({ studentIds: z.array(z.number().int().positive()).min(1).max(2000) }), req.body);
    const owned = db.prepare('SELECT id FROM students WHERE id = ? AND teacher_id = ?');
    const ins = db.prepare('INSERT OR IGNORE INTO enrollments (class_id, student_id) VALUES (?, ?)');
    let added = 0;
    db.transaction(() => {
      for (const sid of studentIds) {
        if (!owned.get(sid, user.id)) throw notFound(`Student ${sid}`);
        added += ins.run(id, sid).changes;
      }
    })();
    audit(db, user.id, 'class', id, 'enroll', `Enrolled ${added} student(s)`);
    return { added };
  });

  app.delete('/classes/:id/students/:studentId', async (req) => {
    const user = requireUser(req);
    const { id, studentId } = parse(z.object({ id: z.coerce.number().int().positive(), studentId: z.coerce.number().int().positive() }), req.params);
    getOwnedClass(ctx, user.id, id);
    const r = db.prepare('DELETE FROM enrollments WHERE class_id = ? AND student_id = ?').run(id, studentId);
    if (!r.changes) throw notFound('Enrollment');
    audit(db, user.id, 'class', id, 'unenroll', `Removed student ${studentId} from class`);
    return { ok: true };
  });

  app.get('/classes/:id/export.csv', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const c = getOwnedClass(ctx, user.id, id);
    const rows = db
      .prepare(
        `SELECT s.student_number, s.last_name, s.first_name, s.external_id, s.email FROM enrollments e JOIN students s ON s.id = e.student_id
         WHERE e.class_id = ? AND s.archived_at IS NULL ORDER BY s.last_name COLLATE NOCASE, s.first_name COLLATE NOCASE`,
      )
      .all(id) as Record<string, string | null>[];
    const csv = stringify(rows.map((r) => [r.student_number, r.last_name, r.first_name, r.external_id ?? '', r.email ?? ''].map(csvSafe)), {
      header: true,
      columns: ['student_number', 'last_name', 'first_name', 'lrn', 'email'],
    });
    return sendCsv(reply, `${c.name}${c.section ? '-' + c.section : ''}-roster.csv`, csv);
  });
}
