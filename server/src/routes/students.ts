import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { stringify } from 'csv-stringify/sync';
import type { Ctx } from '../app';
import { AppError, badRequest, conflict, csvSafe, idParam, notFound, optText, parse, reqText, requireUser, sendCsv } from '../http';
import { audit } from '../services/support';
import { normalizeStudentNumber, parseStudentCsv } from '../services/students';
import { getOwnedClass } from './classes';
import { STUDENT_ID_DIGITS } from '../../../shared/sheet/layout';

interface StudentRow {
  id: number;
  teacher_id: number;
  student_number: string;
  first_name: string;
  last_name: string;
  external_id: string | null;
  email: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const dto = (s: StudentRow & { class_names?: string | null }) => ({
  id: s.id,
  studentNumber: s.student_number,
  firstName: s.first_name,
  lastName: s.last_name,
  externalId: s.external_id,
  email: s.email,
  archived: !!s.archived_at,
  createdAt: s.created_at,
  updatedAt: s.updated_at,
  classNames: s.class_names ? s.class_names.split('\u001f') : [],
});

const numberField = z
  .string()
  .trim()
  .max(20)
  .nullish()
  .transform((v, c) => {
    if (!v) return null;
    const n = normalizeStudentNumber(v);
    if (!n) {
      c.addIssue({ code: 'custom', message: `Student number must be 1–${STUDENT_ID_DIGITS} digits so it can be bubbled on the answer sheet.` });
      return z.NEVER;
    }
    return n;
  });

const studentBody = z.object({
  studentNumber: numberField,
  firstName: reqText(80),
  lastName: reqText(80),
  externalId: optText(40),
  email: z
    .string()
    .trim()
    .max(200)
    .nullish()
    .transform((v) => v || null)
    .pipe(z.string().email('Enter a valid email address.').nullable()),
  classIds: z.array(z.number().int().positive()).max(50).optional(),
});

export function getOwnedStudent(ctx: Ctx, teacherId: number, id: number): StudentRow {
  const row = ctx.db.prepare('SELECT * FROM students WHERE id = ? AND teacher_id = ?').get(id, teacherId) as StudentRow | undefined;
  if (!row) throw notFound('Student');
  return row;
}

/** Next free student number for a teacher (starting at 1001). */
function nextStudentNumber(ctx: Ctx, teacherId: number, reserved: Set<string> = new Set()): string {
  const row = ctx.db.prepare('SELECT MAX(CAST(student_number AS INTEGER)) AS m FROM students WHERE teacher_id = ?').get(teacherId) as { m: number | null };
  let n = Math.max(1000, row.m ?? 0) + 1;
  while (reserved.has(String(n))) n++;
  if (String(n).length > STUDENT_ID_DIGITS) throw new AppError(400, 'NUMBERS_EXHAUSTED', 'No student numbers left; assign numbers manually.');
  return String(n);
}

export async function studentRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  const numberTaken = (teacherId: number, num: string, exceptId = 0) =>
    db.prepare('SELECT id, first_name, last_name FROM students WHERE teacher_id = ? AND student_number = ? AND id <> ?').get(teacherId, num, exceptId) as
      | { id: number; first_name: string; last_name: string }
      | undefined;

  app.get('/students', async (req) => {
    const user = requireUser(req);
    const q = parse(
      z.object({
        q: z.string().trim().max(100).optional(),
        classId: z.coerce.number().int().positive().optional(),
        archived: z.enum(['0', '1', 'all']).default('0'),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(500).default(50),
        sort: z.enum(['name', 'number', 'created']).default('name'),
      }),
      req.query,
    );
    const where: string[] = ['s.teacher_id = ?'];
    const params: unknown[] = [user.id];
    if (q.archived === '0') where.push('s.archived_at IS NULL');
    if (q.archived === '1') where.push('s.archived_at IS NOT NULL');
    if (q.q) {
      where.push(`(s.first_name LIKE ? ESCAPE '\\' OR s.last_name LIKE ? ESCAPE '\\' OR s.student_number LIKE ? ESCAPE '\\' OR (s.first_name || ' ' || s.last_name) LIKE ? ESCAPE '\\' OR s.external_id LIKE ? ESCAPE '\\')`);
      const like = `%${q.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      params.push(like, like, like, like, like);
    }
    if (q.classId) {
      getOwnedClass(ctx, user.id, q.classId);
      where.push('EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = s.id AND e.class_id = ?)');
      params.push(q.classId);
    }
    const order = q.sort === 'number' ? 'CAST(s.student_number AS INTEGER)' : q.sort === 'created' ? 's.created_at DESC' : 's.last_name COLLATE NOCASE, s.first_name COLLATE NOCASE';
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM students s WHERE ${where.join(' AND ')}`).get(...params) as { n: number }).n;
    const rows = db
      .prepare(
        `SELECT s.*, (SELECT group_concat(c.name || ifnull(' – ' || c.section, ''), char(31)) FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = s.id AND c.archived_at IS NULL) AS class_names
         FROM students s WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as (StudentRow & { class_names: string | null })[];
    return { students: rows.map(dto), total, page: q.page, pageSize: q.pageSize };
  });

  app.post('/students', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(studentBody, req.body);
    const num = body.studentNumber ?? nextStudentNumber(ctx, user.id);
    const taken = numberTaken(user.id, num);
    if (taken) throw conflict(`Student number ${num} is already assigned to ${taken.first_name} ${taken.last_name}.`);
    const id = db.transaction(() => {
      const info = db
        .prepare('INSERT INTO students (teacher_id, student_number, first_name, last_name, external_id, email) VALUES (?, ?, ?, ?, ?, ?)')
        .run(user.id, num, body.firstName, body.lastName, body.externalId, body.email);
      const sid = Number(info.lastInsertRowid);
      for (const cid of body.classIds ?? []) {
        getOwnedClass(ctx, user.id, cid);
        db.prepare('INSERT OR IGNORE INTO enrollments (class_id, student_id) VALUES (?, ?)').run(cid, sid);
      }
      audit(db, user.id, 'student', sid, 'create', `Added student ${body.firstName} ${body.lastName} (#${num})`);
      return sid;
    })();
    return reply.status(201).send({ student: dto(getOwnedStudent(ctx, user.id, id)) });
  });

  app.get('/students/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const s = getOwnedStudent(ctx, user.id, id);
    const classes = db
      .prepare('SELECT c.id, c.name, c.section, c.archived_at FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = ? ORDER BY c.name')
      .all(id) as { id: number; name: string; section: string | null; archived_at: string | null }[];
    const history = db
      .prepare(
        `SELECT sub.id, sub.percent, sub.raw_score, sub.total_points, sub.passed, sub.created_at, g.id AS session_id, g.name AS session_name, g.held_on,
                q.title AS quiz_title, q.subject AS quiz_subject
         FROM submissions sub JOIN grading_sessions g ON g.id = sub.session_id JOIN quizzes q ON q.id = g.quiz_id
         WHERE sub.student_id = ? AND g.teacher_id = ? ORDER BY COALESCE(g.held_on, substr(g.created_at, 1, 10)), g.created_at`,
      )
      .all(id, user.id) as {
      id: number;
      percent: number;
      raw_score: number;
      total_points: number;
      passed: number;
      created_at: string;
      session_id: number;
      session_name: string;
      held_on: string | null;
      quiz_title: string;
      quiz_subject: string | null;
    }[];
    return {
      student: dto(s),
      classes: classes.map((c) => ({ id: c.id, name: c.name, section: c.section, archived: !!c.archived_at })),
      history: history.map((h) => ({
        submissionId: h.id,
        sessionId: h.session_id,
        sessionName: h.session_name,
        heldOn: h.held_on,
        quizTitle: h.quiz_title,
        quizSubject: h.quiz_subject,
        percent: h.percent,
        rawScore: h.raw_score,
        totalPoints: h.total_points,
        passed: !!h.passed,
        gradedAt: h.created_at,
      })),
    };
  });

  app.put('/students/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const before = getOwnedStudent(ctx, user.id, id);
    const body = parse(studentBody, req.body);
    const num = body.studentNumber ?? before.student_number;
    const taken = numberTaken(user.id, num, id);
    if (taken) throw conflict(`Student number ${num} is already assigned to ${taken.first_name} ${taken.last_name}.`);
    db.transaction(() => {
      db.prepare(
        `UPDATE students SET student_number = ?, first_name = ?, last_name = ?, external_id = ?, email = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      ).run(num, body.firstName, body.lastName, body.externalId, body.email, id);
      if (body.classIds) {
        for (const cid of body.classIds) getOwnedClass(ctx, user.id, cid);
        db.prepare('DELETE FROM enrollments WHERE student_id = ? AND class_id NOT IN (SELECT value FROM json_each(?))').run(id, JSON.stringify(body.classIds));
        for (const cid of body.classIds) db.prepare('INSERT OR IGNORE INTO enrollments (class_id, student_id) VALUES (?, ?)').run(cid, id);
      }
      audit(db, user.id, 'student', id, 'update', `Updated student ${body.firstName} ${body.lastName}`, {
        studentNumber: before.student_number !== num ? { from: before.student_number, to: num } : undefined,
      });
    })();
    return { student: dto(getOwnedStudent(ctx, user.id, id)) };
  });

  app.post('/students/:id/archive', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const s = getOwnedStudent(ctx, user.id, id);
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    db.prepare(`UPDATE students SET archived_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(archived ? new Date().toISOString() : null, id);
    audit(db, user.id, 'student', id, archived ? 'archive' : 'restore', `${archived ? 'Archived' : 'Restored'} ${s.first_name} ${s.last_name}`);
    return { student: dto(getOwnedStudent(ctx, user.id, id)) };
  });

  /** Permanent deletion of a student and all of their results (privacy requests). */
  app.delete('/students/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const s = getOwnedStudent(ctx, user.id, id);
    const results = (db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE student_id = ?').get(id) as { n: number }).n;
    db.transaction(() => {
      db.prepare('DELETE FROM students WHERE id = ?').run(id);
      audit(db, user.id, 'student', id, 'delete', `Permanently deleted student #${s.student_number} and ${results} result(s)`);
    })();
    return { ok: true, deletedResults: results };
  });

  app.post('/students/import', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        csv: z.string().min(1, 'The file is empty.').max(1_000_000, 'The file is too large (1 MB max).'),
        classId: z.number().int().positive().optional(),
        onExisting: z.enum(['skip', 'update']).default('skip'),
        dryRun: z.boolean().default(true),
      }),
      req.body,
    );
    if (body.classId) getOwnedClass(ctx, user.id, body.classId);
    const { rows, errors } = parseStudentCsv(body.csv);
    if (!rows.length && errors.length) return { dryRun: body.dryRun, created: 0, updated: 0, skipped: 0, enrolled: 0, errors, preview: [] };

    const existingByNumber = db.prepare('SELECT * FROM students WHERE teacher_id = ? AND student_number = ?');
    const reserved = new Set(rows.map((r) => r.studentNumber).filter((n): n is string => !!n));
    const plan = rows.map((r) => {
      const existing = r.studentNumber ? (existingByNumber.get(user.id, r.studentNumber) as StudentRow | undefined) : undefined;
      let action: 'create' | 'update' | 'skip' = 'create';
      if (existing) action = body.onExisting === 'update' ? 'update' : 'skip';
      let studentNumber = r.studentNumber;
      if (!studentNumber) {
        studentNumber = nextStudentNumber(ctx, user.id, reserved);
        reserved.add(studentNumber);
      }
      return { ...r, studentNumber, action, existingId: existing?.id ?? null, existingName: existing ? `${existing.first_name} ${existing.last_name}` : null };
    });
    const preview = plan.map((p) => ({ line: p.line, action: p.action, studentNumber: p.studentNumber, firstName: p.firstName, lastName: p.lastName, existingName: p.existingName }));
    if (body.dryRun) {
      return {
        dryRun: true,
        created: plan.filter((p) => p.action === 'create').length,
        updated: plan.filter((p) => p.action === 'update').length,
        skipped: plan.filter((p) => p.action === 'skip').length,
        enrolled: 0,
        errors,
        preview,
      };
    }
    if (errors.length) throw badRequest('Fix the rows with errors before importing.', errors);

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let enrolled = 0;
    db.transaction(() => {
      const ins = db.prepare('INSERT INTO students (teacher_id, student_number, first_name, last_name, external_id, email) VALUES (?, ?, ?, ?, ?, ?)');
      const upd = db.prepare(
        `UPDATE students SET first_name = ?, last_name = ?, external_id = COALESCE(?, external_id), email = COALESCE(?, email), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      );
      const enroll = db.prepare('INSERT OR IGNORE INTO enrollments (class_id, student_id) VALUES (?, ?)');
      for (const p of plan) {
        let sid: number;
        if (p.action === 'create') {
          if (numberTaken(user.id, p.studentNumber)) throw conflict(`Student number ${p.studentNumber} (line ${p.line}) is already in use.`);
          sid = Number(ins.run(user.id, p.studentNumber, p.firstName, p.lastName, p.externalId, p.email).lastInsertRowid);
          created++;
        } else if (p.action === 'update') {
          upd.run(p.firstName, p.lastName, p.externalId, p.email, p.existingId);
          sid = p.existingId!;
          updated++;
        } else {
          sid = p.existingId!;
          skipped++;
        }
        if (body.classId) enrolled += enroll.run(body.classId, sid).changes;
      }
      audit(db, user.id, 'student', null, 'import', `Imported roster: ${created} new, ${updated} updated, ${skipped} skipped`, { classId: body.classId });
    })();
    return { dryRun: false, created, updated, skipped, enrolled, errors: [], preview };
  });

  app.get('/students/export.csv', async (req, reply) => {
    const user = requireUser(req);
    const rows = db
      .prepare('SELECT * FROM students WHERE teacher_id = ? AND archived_at IS NULL ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE')
      .all(user.id) as StudentRow[];
    const csv = stringify(
      rows.map((r) => [r.student_number, r.last_name, r.first_name, r.external_id ?? '', r.email ?? ''].map(csvSafe)),
      { header: true, columns: ['student_number', 'last_name', 'first_name', 'lrn', 'email'] },
    );
    return sendCsv(reply, 'students.csv', csv);
  });
}
