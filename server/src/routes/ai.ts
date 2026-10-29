import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app';
import { AppError, idParam, notFound, parse, requireUser } from '../http';
import { audit } from '../services/support';
import { loadQuestions } from '../services/grading';
import type { InsightsInput } from '../ai/service';
import { getOwnedSession, sessionAnalytics } from './sessions';
import { getOwnedQuiz } from './quizzes';

const aiLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

function sessionInput(ctx: Ctx, teacherId: number, sessionId: number): { input: InsightsInput; choiceCount: number } {
  const session = getOwnedSession(ctx, teacherId, sessionId);
  const quiz = getOwnedQuiz(ctx, teacherId, session.quiz_id);
  const a = sessionAnalytics(ctx.db, session, quiz);
  const questionText = new Map<number, { prompt: string; choices: string[] | null }>();
  for (const q of loadQuestions(ctx.db, quiz.id)) {
    if (q.prompt) questionText.set(q.number, { prompt: q.prompt, choices: q.choices_json ? (JSON.parse(q.choices_json) as string[]) : null });
  }
  return {
    input: {
      quiz: { title: quiz.title, subject: quiz.subject, questionCount: quiz.question_count, choiceCount: quiz.choice_count },
      passPercent: a.passPercent,
      stats: a.stats,
      passRate: a.passRate,
      distribution: a.distribution,
      items: a.items,
      topics: a.topics,
      questionText,
    },
    choiceCount: quiz.choice_count,
  };
}

const difficulty = z.enum(['easy', 'medium', 'hard', 'mixed']).default('mixed');

export async function aiRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, ai } = ctx;

  app.get('/ai/status', async (req) => {
    const user = requireUser(req);
    return { ...ai.status(), usage: ai.usage(user.id) };
  });

  app.post('/ai/sessions/:id/insights', { config: aiLimit }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { input } = sessionInput(ctx, user.id, id);
    return ai.insights(user.id, id, input);
  });

  app.post('/ai/sessions/:id/practice', { config: aiLimit }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { input, choiceCount } = sessionInput(ctx, user.id, id);
    return ai.practice(user.id, id, input, choiceCount);
  });

  /** Most recent saved AI output for a session (so teachers can revisit it without paying again). */
  app.get('/ai/sessions/:id/latest', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    getOwnedSession(ctx, user.id, id);
    const pick = (feature: string) => {
      const row = db
        .prepare(`SELECT id, output_json, created_at FROM ai_requests WHERE teacher_id = ? AND session_id = ? AND feature = ? AND status = 'ok' ORDER BY id DESC LIMIT 1`)
        .get(user.id, id, feature) as { id: number; output_json: string; created_at: string } | undefined;
      return row ? { id: row.id, createdAt: row.created_at, output: JSON.parse(row.output_json) } : null;
    };
    return { insights: pick('insights'), practice: pick('practice') };
  });

  app.post('/ai/questions', { config: aiLimit }, async (req) => {
    const user = requireUser(req);
    const p = parse(
      z.object({
        subject: z.string().trim().min(1).max(100),
        topic: z.string().trim().min(1).max(200),
        gradeLevel: z.string().trim().min(1).max(60),
        difficulty,
        count: z.number().int().min(1).max(25),
        choiceCount: z.number().int().min(2).max(5).default(4),
        objectives: z.string().trim().max(3000).nullish(),
        language: z.string().trim().max(40).nullish(),
      }),
      req.body,
    );
    return ai.questions(user.id, p);
  });

  app.post('/ai/quiz-draft', { config: aiLimit }, async (req) => {
    const user = requireUser(req);
    const p = parse(
      z
        .object({
          subject: z.string().trim().min(1).max(100),
          gradeLevel: z.string().trim().min(1).max(60),
          title: z.string().trim().max(160).nullish(),
          objectives: z.string().trim().max(3000).nullish(),
          material: z.string().max(30_000, 'Teaching material is limited to 30,000 characters.').nullish(),
          questionCount: z.number().int().min(1).max(30),
          choiceCount: z.number().int().min(2).max(5).default(4),
          difficulty,
        })
        .refine((v) => v.objectives || v.material, { message: 'Provide learning objectives or teaching material.' }),
      req.body,
    );
    return ai.quizDraft(user.id, p);
  });

  app.post('/ai/quizzes/:id/questions/:number/explain', { config: aiLimit }, async (req) => {
    const user = requireUser(req);
    const { id, number } = parse(z.object({ id: z.coerce.number().int().positive(), number: z.coerce.number().int().min(1).max(100) }), req.params);
    const quiz = getOwnedQuiz(ctx, user.id, id);
    const q = loadQuestions(db, id).find((x) => x.number === number);
    if (!q) throw notFound('Question');
    const choices = q.choices_json ? (JSON.parse(q.choices_json) as string[]) : null;
    if (!q.prompt || !choices?.length) throw new AppError(400, 'NO_QUESTION_TEXT', 'Add the question text and choice texts to this question first; the AI needs them to explain it.');
    if (q.correct_choice === null) throw new AppError(400, 'NO_KEY', 'Set the correct answer for this question first.');
    return ai.explain(user.id, id, { number, prompt: q.prompt, choices, correctChoice: q.correct_choice, subject: quiz.subject });
  });

  /** Saves a reviewed explanation onto the question (teacher action). */
  app.put('/quizzes/:id/questions/:number/explanation', async (req) => {
    const user = requireUser(req);
    const { id, number } = parse(z.object({ id: z.coerce.number().int().positive(), number: z.coerce.number().int().min(1).max(100) }), req.params);
    getOwnedQuiz(ctx, user.id, id);
    const { explanation } = parse(z.object({ explanation: z.string().trim().max(4000) }), req.body);
    const r = db.prepare('UPDATE questions SET explanation = ? WHERE quiz_id = ? AND number = ?').run(explanation || null, id, number);
    if (!r.changes) throw notFound('Question');
    db.prepare(`UPDATE quizzes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(id);
    audit(db, user.id, 'quiz', id, 'explanation', `Saved explanation for question ${number}`);
    return { ok: true };
  });
}
