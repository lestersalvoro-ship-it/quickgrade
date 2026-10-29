import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { stringify } from 'csv-stringify/sync';
import type { Ctx } from '../app';
import type { DB } from '../db/index';
import { AppError, conflict, csvSafe, idParam, notFound, optText, parse, reqText, requireUser, sendCsv, sendPdf } from '../http';
import { audit } from '../services/support';
import { assertGradable, keyFor, loadQuestions, regradeQuiz, type QuestionRow, type QuizRow } from '../services/grading';
import { validateAnswerKey, choiceLetter } from '../../../shared/grading';
import { MAX_CHOICES, MAX_QUESTIONS, MIN_CHOICES, MIN_QUESTIONS } from '../../../shared/sheet/layout';
import { MAX_QUIZ_SHEET_CODE } from '../../../shared/sheet/code';
import { renderAnswerSheetPdf } from '../pdf/answerSheet';
import { renderAnswerKeyPdf } from '../pdf/reports';
import { getOwnedClass } from './classes';

export function getOwnedQuiz(ctx: Ctx, teacherId: number, id: number): QuizRow {
  const row = ctx.db.prepare('SELECT * FROM quizzes WHERE id = ? AND teacher_id = ?').get(id, teacherId) as QuizRow | undefined;
  if (!row) throw notFound('Quiz');
  return row;
}

function parseChoices(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null;
  } catch {
    return null;
  }
}

export const questionDto = (q: QuestionRow) => ({
  number: q.number,
  correctChoice: q.correct_choice,
  points: q.points,
  excluded: !!q.excluded,
  topic: q.topic,
  prompt: q.prompt,
  choices: parseChoices(q.choices_json),
  explanation: q.explanation,
});

export function quizDto(db: DB, q: QuizRow, questions?: QuestionRow[]) {
  const qs = questions ?? loadQuestions(db, q.id);
  const issues = validateAnswerKey(keyFor(qs), q.question_count, q.choice_count);
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM grading_sessions WHERE quiz_id = ?) AS sessions,
              (SELECT COUNT(*) FROM submissions s JOIN grading_sessions g ON g.id = s.session_id WHERE g.quiz_id = ?) AS submissions`,
    )
    .get(q.id, q.id) as { sessions: number; submissions: number };
  return {
    id: q.id,
    title: q.title,
    subject: q.subject,
    description: q.description,
    instructions: q.instructions,
    questionCount: q.question_count,
    choiceCount: q.choice_count,
    sheetCode: q.sheet_code,
    rules: {
      passPercent: q.pass_percent,
      wrongPenalty: q.wrong_penalty,
      penalizeBlank: !!q.penalize_blank,
      multiplePolicy: q.multiple_policy,
      floorAtZero: !!q.floor_at_zero,
    },
    source: q.source,
    archived: !!q.archived_at,
    createdAt: q.created_at,
    updatedAt: q.updated_at,
    keyComplete: issues.length === 0,
    keyIssues: issues,
    answeredCount: qs.filter((x) => x.correct_choice !== null || x.excluded).length,
    totalPoints: qs.filter((x) => !x.excluded).reduce((a, x) => a + x.points, 0),
    sessionCount: counts.sessions,
    submissionCount: counts.submissions,
    questions: qs.map(questionDto),
  };
}

const questionSchema = z.object({
  number: z.number().int().min(1).max(MAX_QUESTIONS),
  correctChoice: z.number().int().min(0).max(MAX_CHOICES - 1).nullable(),
  points: z.number().positive('Points must be greater than 0.').max(100).default(1),
  excluded: z.boolean().default(false),
  topic: optText(100),
  prompt: optText(2000),
  choices: z.array(z.string().trim().max(500)).max(MAX_CHOICES).nullish(),
  explanation: optText(4000),
});

const rulesSchema = z.object({
  passPercent: z.number().min(0).max(100).nullable().default(null),
  wrongPenalty: z.number().min(0).max(10).default(0),
  penalizeBlank: z.boolean().default(false),
  multiplePolicy: z.enum(['incorrect', 'blank']).default('incorrect'),
  floorAtZero: z.boolean().default(true),
});

export const quizBody = z
  .object({
    title: reqText(160),
    subject: optText(100),
    description: optText(2000),
    instructions: optText(2000),
    questionCount: z.number().int().min(MIN_QUESTIONS).max(MAX_QUESTIONS),
    choiceCount: z.number().int().min(MIN_CHOICES).max(MAX_CHOICES),
    rules: rulesSchema.default({ passPercent: null, wrongPenalty: 0, penalizeBlank: false, multiplePolicy: 'incorrect', floorAtZero: true }),
    questions: z.array(questionSchema).max(MAX_QUESTIONS).default([]),
    source: z.enum(['manual', 'ai_assisted']).default('manual'),
  })
  .superRefine((v, c) => {
    const nums = new Set<number>();
    for (const q of v.questions) {
      if (q.number > v.questionCount) c.addIssue({ code: 'custom', path: ['questions'], message: `Question ${q.number} is beyond the quiz length (${v.questionCount}).` });
      if (nums.has(q.number)) c.addIssue({ code: 'custom', path: ['questions'], message: `Question ${q.number} is listed twice.` });
      nums.add(q.number);
      if (q.correctChoice !== null && q.correctChoice >= v.choiceCount) {
        c.addIssue({ code: 'custom', path: ['questions'], message: `Question ${q.number}: answer ${choiceLetter(q.correctChoice)} is not available with ${v.choiceCount} choices.` });
      }
      if (q.choices && q.choices.length && q.choices.length !== v.choiceCount) {
        c.addIssue({ code: 'custom', path: ['questions'], message: `Question ${q.number} must have exactly ${v.choiceCount} choice texts (or none).` });
      }
    }
  });
export type QuizBody = z.infer<typeof quizBody>;

function newSheetCode(db: DB): number {
  for (let i = 0; i < 50; i++) {
    const code = crypto.randomInt(1, MAX_QUIZ_SHEET_CODE + 1);
    if (!db.prepare('SELECT 1 FROM quizzes WHERE sheet_code = ?').get(code)) return code;
  }
  throw new AppError(500, 'SHEET_CODE_EXHAUSTED', 'Could not allocate a sheet code.');
}

function writeQuestions(db: DB, quizId: number, body: QuizBody) {
  db.prepare('DELETE FROM questions WHERE quiz_id = ?').run(quizId);
  const ins = db.prepare(
    'INSERT INTO questions (quiz_id, number, correct_choice, points, excluded, topic, prompt, choices_json, explanation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const byNum = new Map(body.questions.map((q) => [q.number, q]));
  for (let n = 1; n <= body.questionCount; n++) {
    const q = byNum.get(n);
    ins.run(
      quizId,
      n,
      q?.correctChoice ?? null,
      q?.points ?? 1,
      q?.excluded ? 1 : 0,
      q?.topic ?? null,
      q?.prompt ?? null,
      q?.choices?.length ? JSON.stringify(q.choices) : null,
      q?.explanation ?? null,
    );
  }
}

/** Creates a quiz (used by the quiz editor and by AI-assisted drafts after teacher review). */
export function createQuiz(db: DB, teacherId: number, body: QuizBody, source: 'manual' | 'ai_assisted' | 'duplicate' = body.source): number {
  return db.transaction(() => {
    const r = body.rules;
    const info = db
      .prepare(
        `INSERT INTO quizzes (teacher_id, title, subject, description, instructions, question_count, choice_count, sheet_code, pass_percent, wrong_penalty, penalize_blank, multiple_policy, floor_at_zero, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        teacherId,
        body.title,
        body.subject,
        body.description,
        body.instructions,
        body.questionCount,
        body.choiceCount,
        newSheetCode(db),
        r.passPercent,
        r.wrongPenalty,
        r.penalizeBlank ? 1 : 0,
        r.multiplePolicy,
        r.floorAtZero ? 1 : 0,
        source,
      );
    const id = Number(info.lastInsertRowid);
    writeQuestions(db, id, body);
    audit(db, teacherId, 'quiz', id, 'create', `Created quiz "${body.title}" (${body.questionCount} items)${source === 'ai_assisted' ? ' from an AI-assisted draft' : ''}`);
    return id;
  })();
}

export async function quizRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/quizzes', async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({ archived: z.enum(['0', '1', 'all']).default('0'), q: z.string().trim().max(100).optional() }), req.query);
    const where = ['teacher_id = ?'];
    const params: unknown[] = [user.id];
    if (q.archived === '0') where.push('archived_at IS NULL');
    if (q.archived === '1') where.push('archived_at IS NOT NULL');
    if (q.q) {
      where.push(`(title LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\')`);
      const like = `%${q.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      params.push(like, like);
    }
    const rows = db.prepare(`SELECT * FROM quizzes WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`).all(...params) as QuizRow[];
    return {
      quizzes: rows.map((r) => {
        const { questions: _q, ...rest } = quizDto(db, r);
        return rest;
      }),
    };
  });

  app.post('/quizzes', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(quizBody, req.body);
    const id = createQuiz(db, user.id, body);
    return reply.status(201).send({ quiz: quizDto(db, getOwnedQuiz(ctx, user.id, id)) });
  });

  app.get('/quizzes/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    return { quiz: quizDto(db, getOwnedQuiz(ctx, user.id, id)) };
  });

  app.put('/quizzes/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const before = getOwnedQuiz(ctx, user.id, id);
    const beforeQs = loadQuestions(db, id);
    const body = parse(quizBody, req.body);
    const structureChanged = before.question_count !== body.questionCount || before.choice_count !== body.choiceCount;
    const submissions = (db.prepare('SELECT COUNT(*) AS n FROM submissions s JOIN grading_sessions g ON g.id = s.session_id WHERE g.quiz_id = ?').get(id) as { n: number }).n;
    if (structureChanged && submissions > 0) {
      throw conflict('The number of questions or choices cannot change after results have been saved. Duplicate the quiz to make a new version.');
    }
    const result = db.transaction(() => {
      const r = body.rules;
      // A new layout invalidates previously printed sheets, so issue a new sheet code.
      const sheetCode = structureChanged ? newSheetCode(db) : before.sheet_code;
      db.prepare(
        `UPDATE quizzes SET title = ?, subject = ?, description = ?, instructions = ?, question_count = ?, choice_count = ?, sheet_code = ?, pass_percent = ?, wrong_penalty = ?,
           penalize_blank = ?, multiple_policy = ?, floor_at_zero = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      ).run(
        body.title,
        body.subject,
        body.description,
        body.instructions,
        body.questionCount,
        body.choiceCount,
        sheetCode,
        r.passPercent,
        r.wrongPenalty,
        r.penalizeBlank ? 1 : 0,
        r.multiplePolicy,
        r.floorAtZero ? 1 : 0,
        id,
      );
      writeQuestions(db, id, body);
      const after = getOwnedQuiz(ctx, user.id, id);
      const afterQs = loadQuestions(db, id);
      const keyChanges = afterQs
        .map((q) => {
          const b = beforeQs.find((x) => x.number === q.number);
          if (!b) return null;
          const changes: string[] = [];
          if (b.correct_choice !== q.correct_choice) changes.push(`answer ${choiceLetter(b.correct_choice)}→${choiceLetter(q.correct_choice)}`);
          if (b.points !== q.points) changes.push(`points ${b.points}→${q.points}`);
          if (!!b.excluded !== !!q.excluded) changes.push(q.excluded ? 'excluded' : 'included');
          return changes.length ? { number: q.number, changes } : null;
        })
        .filter(Boolean);
      let regraded = 0;
      if (submissions > 0) {
        assertGradable(after, afterQs);
        regraded = regradeQuiz(db, after, afterQs);
      }
      audit(
        db,
        user.id,
        'quiz',
        id,
        'update',
        `Updated quiz "${body.title}"${keyChanges.length ? `; ${keyChanges.length} answer-key change(s)` : ''}${regraded ? `; regraded ${regraded} result(s)` : ''}${structureChanged ? '; layout changed (reprint sheets)' : ''}`,
        { keyChanges, regraded, structureChanged },
      );
      return { regraded, structureChanged };
    })();
    return { quiz: quizDto(db, getOwnedQuiz(ctx, user.id, id)), ...result };
  });

  app.post('/quizzes/:id/duplicate', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const q = getOwnedQuiz(ctx, user.id, id);
    const dto = quizDto(db, q);
    const body = parse(quizBody, {
      title: `${q.title} (copy)`.slice(0, 160),
      subject: q.subject,
      description: q.description,
      instructions: q.instructions,
      questionCount: q.question_count,
      choiceCount: q.choice_count,
      rules: dto.rules,
      questions: dto.questions,
    });
    const newId = createQuiz(db, user.id, body, 'duplicate');
    return reply.status(201).send({ quiz: quizDto(db, getOwnedQuiz(ctx, user.id, newId)) });
  });

  app.post('/quizzes/:id/archive', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const q = getOwnedQuiz(ctx, user.id, id);
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    db.prepare(`UPDATE quizzes SET archived_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(archived ? new Date().toISOString() : null, id);
    audit(db, user.id, 'quiz', id, archived ? 'archive' : 'restore', `${archived ? 'Archived' : 'Restored'} quiz "${q.title}"`);
    return { quiz: quizDto(db, getOwnedQuiz(ctx, user.id, id)) };
  });

  app.delete('/quizzes/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const q = getOwnedQuiz(ctx, user.id, id);
    const sessions = (db.prepare('SELECT COUNT(*) AS n FROM grading_sessions WHERE quiz_id = ?').get(id) as { n: number }).n;
    if (sessions) throw conflict('This quiz has grading sessions. Archive it instead, or delete its grading sessions first.');
    db.transaction(() => {
      db.prepare('DELETE FROM quizzes WHERE id = ?').run(id);
      audit(db, user.id, 'quiz', id, 'delete', `Deleted quiz "${q.title}"`);
    })();
    return { ok: true };
  });

  app.get('/quizzes/:id/sheets.pdf', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const q = getOwnedQuiz(ctx, user.id, id);
    const opts = parse(
      z.object({
        paper: z.enum(['A4', 'LETTER']).default('A4'),
        copies: z.coerce.number().int().min(1).max(200).default(1),
        classId: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    let students: { name: string; studentNumber: string; className: string | null }[] | undefined;
    if (opts.classId) {
      const c = getOwnedClass(ctx, user.id, opts.classId);
      const rows = db
        .prepare(
          `SELECT s.first_name, s.last_name, s.student_number FROM enrollments e JOIN students s ON s.id = e.student_id
           WHERE e.class_id = ? AND s.archived_at IS NULL ORDER BY s.last_name COLLATE NOCASE, s.first_name COLLATE NOCASE`,
        )
        .all(c.id) as { first_name: string; last_name: string; student_number: string }[];
      if (!rows.length) throw new AppError(400, 'EMPTY_CLASS', 'This class has no active students to print sheets for.');
      const className = `${c.name}${c.section ? ' – ' + c.section : ''}`;
      students = rows.map((r) => ({ name: `${r.last_name}, ${r.first_name}`, studentNumber: r.student_number, className }));
    }
    const pdf = await renderAnswerSheetPdf({
      quiz: { title: q.title, subject: q.subject, questionCount: q.question_count, choiceCount: q.choice_count, sheetCode: q.sheet_code },
      paper: opts.paper,
      copies: opts.copies,
      students,
    });
    audit(db, user.id, 'quiz', id, 'print_sheets', `Generated ${students ? students.length + ' personalised' : opts.copies + ' blank'} answer sheet(s) (${opts.paper})`);
    return sendPdf(reply, `${q.title}-answer-sheets.pdf`, pdf, true);
  });

  app.get('/quizzes/:id/key.pdf', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const q = getOwnedQuiz(ctx, user.id, id);
    const pdf = await renderAnswerKeyPdf(q, loadQuestions(db, id));
    return sendPdf(reply, `${q.title}-answer-key.pdf`, pdf, true);
  });

  app.get('/quizzes/:id/key.csv', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const q = getOwnedQuiz(ctx, user.id, id);
    const rows = loadQuestions(db, id).map((x) => [x.number, choiceLetter(x.correct_choice), x.points, x.excluded ? 'yes' : 'no', csvSafe(x.topic ?? '')]);
    return sendCsv(reply, `${q.title}-answer-key.csv`, stringify(rows, { header: true, columns: ['question', 'answer', 'points', 'excluded', 'topic'] }));
  });
}
