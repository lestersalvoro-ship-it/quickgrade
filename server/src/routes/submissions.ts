import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app';
import { AppError, idParam, notFound, parse, requireUser } from '../http';
import { audit } from '../services/support';
import { loadQuestions, loadResponses, rulesFor, assertGradable, validateResponses, keyFor, type QuizRow } from '../services/grading';
import { gradeSubmission, maskFromChoices, choiceLetter } from '../../../shared/grading';
import type { SessionRow } from './sessions';

interface SubmissionRow {
  id: number;
  session_id: number;
  student_id: number;
  source: string;
  raw_score: number;
  total_points: number;
  percent: number;
  correct_count: number;
  incorrect_count: number;
  blank_count: number;
  multiple_count: number;
  passed: number;
  teacher_edits: number;
  created_at: string;
  updated_at: string;
}

function getOwnedSubmission(ctx: Ctx, teacherId: number, id: number) {
  const row = ctx.db
    .prepare('SELECT s.* FROM submissions s JOIN grading_sessions g ON g.id = s.session_id WHERE s.id = ? AND g.teacher_id = ?')
    .get(id, teacherId) as SubmissionRow | undefined;
  if (!row) throw notFound('Result');
  const session = ctx.db.prepare('SELECT * FROM grading_sessions WHERE id = ?').get(row.session_id) as SessionRow;
  const quiz = ctx.db.prepare('SELECT * FROM quizzes WHERE id = ?').get(session.quiz_id) as QuizRow;
  return { sub: row, session, quiz };
}

export async function submissionRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/submissions/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { sub, session, quiz } = getOwnedSubmission(ctx, user.id, id);
    const student = db.prepare('SELECT id, first_name, last_name, student_number FROM students WHERE id = ?').get(sub.student_id) as {
      id: number;
      first_name: string;
      last_name: string;
      student_number: string;
    };
    const questions = loadQuestions(db, quiz.id);
    const responses = loadResponses(db, id);
    const scan = db.prepare('SELECT id, rectified_path, image_path FROM scans WHERE submission_id = ?').get(id) as
      | { id: number; rectified_path: string | null; image_path: string | null }
      | undefined;
    const history = db
      .prepare(`SELECT action, summary, details_json, created_at FROM audit_logs WHERE teacher_id = ? AND entity_type = 'submission' AND entity_id = ? ORDER BY id DESC`)
      .all(user.id, id) as { action: string; summary: string; details_json: string | null; created_at: string }[];
    const pass = rulesFor(quiz, user.defaultPassPercent).passPercent;
    return {
      submission: {
        id: sub.id,
        source: sub.source,
        rawScore: sub.raw_score,
        totalPoints: sub.total_points,
        percent: sub.percent,
        correct: sub.correct_count,
        incorrect: sub.incorrect_count,
        blank: sub.blank_count,
        multiple: sub.multiple_count,
        passed: sub.percent >= pass,
        passPercent: pass,
        teacherEdits: sub.teacher_edits,
        gradedAt: sub.created_at,
        updatedAt: sub.updated_at,
      },
      student: { id: student.id, firstName: student.first_name, lastName: student.last_name, studentNumber: student.student_number },
      session: { id: session.id, name: session.name, heldOn: session.held_on },
      quiz: { id: quiz.id, title: quiz.title, questionCount: quiz.question_count, choiceCount: quiz.choice_count },
      questions: questions.map((q) => {
        const r = responses.find((x) => x.number === q.number);
        return {
          number: q.number,
          correctChoice: q.correct_choice,
          points: q.points,
          excluded: !!q.excluded,
          topic: q.topic,
          status: r?.status ?? 'blank',
          choice: r?.choice ?? null,
          marked: r?.marked ?? [],
          isCorrect: r?.isCorrect ?? false,
          pointsAwarded: r?.pointsAwarded ?? 0,
          scannerStatus: r?.scannerStatus ?? null,
          scannerConfidence: r?.scannerConfidence ?? null,
          teacherOverride: r?.teacherOverride ?? false,
        };
      }),
      scan: scan ? { id: scan.id, hasRectifiedImage: !!scan.rectified_path, hasOriginalImage: !!scan.image_path } : null,
      history: history.map((h) => ({ action: h.action, summary: h.summary, details: h.details_json ? JSON.parse(h.details_json) : null, at: h.created_at })),
    };
  });

  /** Teacher correction of a saved result; the score is recomputed and the change is audited. */
  app.put('/submissions/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { sub, quiz } = getOwnedSubmission(ctx, user.id, id);
    const body = parse(
      z.object({
        reason: z.string().trim().max(300).optional(),
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
    const questions = loadQuestions(db, quiz.id);
    assertGradable(quiz, questions);
    validateResponses(quiz, body.responses);
    const before = loadResponses(db, id);
    const changed = body.responses.filter((r) => {
      const b = before.find((x) => x.number === r.number);
      return !b || b.status !== r.status || b.choice !== r.choice || (r.status === 'multiple' && maskFromChoices(r.marked ?? []) !== b.markedMask);
    });
    if (!changed.length) throw new AppError(400, 'NO_CHANGES', 'No answers were changed.');
    const rules = rulesFor(quiz, user.defaultPassPercent);
    const grade = gradeSubmission(keyFor(questions), rules, body.responses);
    db.transaction(() => {
      const upd = db.prepare(
        `UPDATE responses SET response_status = ?, choice = ?, marked_mask = ?, is_correct = ?, points_awarded = ?, teacher_override = CASE WHEN ? THEN 1 ELSE teacher_override END
         WHERE submission_id = ? AND question_number = ?`,
      );
      for (const g of grade.questions) {
        const r = body.responses.find((x) => x.number === g.number)!;
        const isChanged = changed.some((c) => c.number === g.number);
        const mask = g.status === 'multiple' ? maskFromChoices(r.marked ?? []) : g.choice !== null ? 1 << g.choice : 0;
        upd.run(g.status, g.choice, mask, g.isCorrect ? 1 : 0, g.pointsAwarded, isChanged ? 1 : 0, id, g.number);
      }
      db.prepare(
        `UPDATE submissions SET raw_score = ?, total_points = ?, percent = ?, correct_count = ?, incorrect_count = ?, blank_count = ?, multiple_count = ?, passed = ?,
           teacher_edits = teacher_edits + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      ).run(grade.rawScore, grade.totalPoints, grade.percent, grade.correctCount, grade.incorrectCount, grade.blankCount, grade.multipleCount, grade.passed ? 1 : 0, changed.length, id);
      const describe = (s: string, c: number | null) => (s === 'answered' ? choiceLetter(c) : s);
      audit(
        db,
        user.id,
        'submission',
        id,
        'correct',
        `Corrected ${changed.length} answer(s): score ${sub.raw_score} → ${grade.rawScore} (${sub.percent}% → ${grade.percent}%)${body.reason ? ` — ${body.reason}` : ''}`,
        {
          changes: changed.map((c) => {
            const b = before.find((x) => x.number === c.number);
            return { question: c.number, from: b ? describe(b.status, b.choice) : null, to: describe(c.status, c.choice) };
          }),
          reason: body.reason ?? null,
        },
      );
    })();
    return { grade };
  });

  app.delete('/submissions/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { sub } = getOwnedSubmission(ctx, user.id, id);
    db.transaction(() => {
      db.prepare(`UPDATE scans SET status = 'discarded' WHERE submission_id = ?`).run(id);
      db.prepare('DELETE FROM submissions WHERE id = ?').run(id);
      audit(db, user.id, 'submission', id, 'delete', `Deleted result (${sub.percent}%) for student ${sub.student_id} in session ${sub.session_id}`);
    })();
    return { ok: true };
  });
}
