import type { DB } from '../db/index';
import type { Config } from '../config';
import { AppError } from '../http';
import { choiceLetter } from '../../../shared/grading';
import { AnthropicProvider } from './anthropic';
import { AiError, DisabledProvider, type AiProvider } from './provider';
import {
  explanationSchema,
  insightsSchema,
  practiceSchema,
  questionSetSchema,
  quizDraftSchema,
  scrubPersonalData,
  validateExplanation,
  validateGeneratedQuestions,
  validateInsights,
  type Explanation,
  type GeneratedQuestion,
  type Insights,
} from './schemas';
import type { ItemStat, SummaryStats, TopicStat, Bin } from '../../../shared/analytics';

export type AiFeature = 'insights' | 'questions' | 'practice' | 'explanation' | 'quiz_draft';

const SYSTEM_BASE = `You are QuickGrade's teaching assistant for school teachers (primary through tertiary, often in the Philippines).
Your output is reviewed by a teacher before anything is used with students.
Rules:
- Be accurate, concrete and concise. Use plain language a busy teacher can act on.
- Never claim to know an individual student's ability, intelligence or misconceptions. You only see aggregate, anonymised data.
- Describe likely reasons for wrong answers as hypotheses ("may indicate"), never as proof.
- Do not invent curriculum topics, standards or facts that are not supported by the data or material provided.
- Write questions that have exactly one defensible correct answer and plausible distractors. Avoid trick questions, "all of the above" and "none of the above".
- Respond in the same language as the teacher's input (default English).`;

export interface InsightsInput {
  quiz: { title: string; subject: string | null; questionCount: number; choiceCount: number };
  passPercent: number;
  stats: SummaryStats;
  passRate: number | null;
  distribution: Bin[];
  items: ItemStat[];
  topics: TopicStat[];
  questionText: Map<number, { prompt: string; choices: string[] | null }>;
}

export interface QuestionParams {
  subject: string;
  topic: string;
  gradeLevel: string;
  difficulty: 'easy' | 'medium' | 'hard' | 'mixed';
  count: number;
  choiceCount: number;
  objectives?: string | null;
  language?: string | null;
}

export interface QuizDraftParams {
  subject: string;
  gradeLevel: string;
  title?: string | null;
  objectives?: string | null;
  material?: string | null;
  questionCount: number;
  choiceCount: number;
  difficulty: 'easy' | 'medium' | 'hard' | 'mixed';
}

export interface AiService {
  status(): { enabled: boolean; provider: string; model: string; message: string };
  usage(teacherId: number): { today: number; dailyLimit: number; monthCostUsd: number; monthBudgetUsd: number; recent: { feature: string; status: string; createdAt: string; costUsd: number }[] };
  insights(teacherId: number, sessionId: number, input: InsightsInput): Promise<{ id: number; insights: Insights }>;
  practice(teacherId: number, sessionId: number, input: InsightsInput, choiceCount: number): Promise<{ id: number; recommendations: { focus: string; activity: string; rationale: string; questions: number[] }[]; questions: GeneratedQuestion[]; rejected: number }>;
  questions(teacherId: number, p: QuestionParams): Promise<{ id: number; questions: GeneratedQuestion[]; rejected: { index: number; reason: string }[] }>;
  explain(teacherId: number, quizId: number, q: { number: number; prompt: string; choices: string[]; correctChoice: number; subject: string | null }): Promise<{ id: number; explanation: Explanation }>;
  quizDraft(teacherId: number, p: QuizDraftParams): Promise<{ id: number; title: string; subject: string; questions: GeneratedQuestion[]; rejected: { index: number; reason: string }[] }>;
}

export function createAiService(db: DB, config: Config, override?: AiProvider): AiService {
  const provider: AiProvider = override ?? (config.aiEnabled ? new AnthropicProvider(config.ANTHROPIC_API_KEY!, config.AI_MODEL, config.AI_TIMEOUT_MS) : new DisabledProvider());
  const enabled = provider.name !== 'none';

  const cost = (inTok: number, outTok: number) => (inTok * config.AI_INPUT_USD_PER_MTOK + outTok * config.AI_OUTPUT_USD_PER_MTOK) / 1_000_000;

  const record = (teacherId: number, feature: AiFeature, status: 'ok' | 'error' | 'rejected', extra: { model?: string; inputTokens?: number; outputTokens?: number; quizId?: number | null; sessionId?: number | null; output?: unknown; error?: string }) => {
    const info = db
      .prepare(
        `INSERT INTO ai_requests (teacher_id, feature, status, model, input_tokens, output_tokens, cost_usd, quiz_id, session_id, output_json, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        teacherId,
        feature,
        status,
        extra.model ?? provider.model,
        extra.inputTokens ?? 0,
        extra.outputTokens ?? 0,
        cost(extra.inputTokens ?? 0, extra.outputTokens ?? 0),
        extra.quizId ?? null,
        extra.sessionId ?? null,
        extra.output === undefined ? null : JSON.stringify(extra.output),
        extra.error ?? null,
      );
    return Number(info.lastInsertRowid);
  };

  const todayCount = (teacherId: number) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ai_requests WHERE teacher_id = ? AND status <> 'rejected' AND created_at >= strftime('%Y-%m-%dT00:00:00.000Z','now')`).get(teacherId) as { n: number }).n;
  const monthCost = () =>
    (db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM ai_requests WHERE created_at >= strftime('%Y-%m-01T00:00:00.000Z','now')`).get() as { c: number }).c;

  async function run<T>(teacherId: number, feature: AiFeature, refs: { quizId?: number | null; sessionId?: number | null }, call: () => Promise<{ data: T; model: string; inputTokens: number; outputTokens: number }>, post: (d: T) => unknown) {
    if (!enabled) throw new AppError(503, 'AI_UNAVAILABLE', 'AI features are not configured on this server. Scanning and grading still work normally.');
    if (todayCount(teacherId) >= config.AI_DAILY_REQUESTS_PER_TEACHER) {
      record(teacherId, feature, 'rejected', { ...refs, error: 'daily limit' });
      throw new AppError(429, 'AI_DAILY_LIMIT', `You have reached today's limit of ${config.AI_DAILY_REQUESTS_PER_TEACHER} AI requests. The limit resets at midnight UTC.`);
    }
    if (config.AI_MONTHLY_BUDGET_USD > 0 && monthCost() >= config.AI_MONTHLY_BUDGET_USD) {
      record(teacherId, feature, 'rejected', { ...refs, error: 'monthly budget' });
      throw new AppError(429, 'AI_BUDGET', 'The AI budget for this month has been used up. An administrator can raise AI_MONTHLY_BUDGET_USD.');
    }
    try {
      const res = await call();
      const output = post(res.data);
      const id = record(teacherId, feature, 'ok', { ...refs, model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, output });
      return { id, output };
    } catch (e) {
      if (e instanceof AppError) throw e;
      const err = e instanceof AiError ? e : new AiError('provider_error', 'Unexpected AI error.');
      record(teacherId, feature, 'error', { ...refs, error: `${err.kind}: ${err.message}`, inputTokens: err.usage?.inputTokens, outputTokens: err.usage?.outputTokens });
      const status = err.kind === 'rate_limited' ? 429 : err.kind === 'invalid_output' || err.kind === 'refused' ? 502 : 503;
      throw new AppError(status, `AI_${err.kind.toUpperCase()}`, err.message);
    }
  }

  /** Aggregated, anonymised description of a grading session. Contains no student names or IDs. */
  function describeSession(input: InsightsInput): string {
    const items = input.items
      .filter((i) => !i.excluded)
      .map((i) => {
        const text = input.questionText.get(i.number);
        const total = i.responses || 1;
        const dist = i.choiceCounts.map((c, k) => `${choiceLetter(k)} ${Math.round((c / total) * 100)}%`).join(', ');
        return {
          question: i.number,
          key: choiceLetter(i.correctChoice),
          percentCorrect: i.percentCorrect,
          responseDistribution: `${dist}, blank ${Math.round((i.blankCount / total) * 100)}%, multiple ${Math.round((i.multipleCount / total) * 100)}%`,
          discrimination: i.discrimination,
          topic: i.topic ?? undefined,
          text: text?.prompt ? text.prompt.slice(0, 600) : undefined,
          choices: text?.choices ? text.choices.map((c, k) => `${choiceLetter(k)}. ${c.slice(0, 200)}`) : undefined,
        };
      });
    return JSON.stringify(
      {
        assessment: { title: input.quiz.title, subject: input.quiz.subject, items: input.quiz.questionCount },
        studentsGraded: input.stats.count,
        passThresholdPercent: input.passPercent,
        scorePercent: { mean: input.stats.mean, median: input.stats.median, min: input.stats.min, max: input.stats.max, stdDev: input.stats.stdDev },
        passRatePercent: input.passRate,
        distribution: input.distribution.map((b) => `${b.label}: ${b.count}`),
        topicsTaggedByTeacher: input.topics.map((t) => ({ topic: t.topic, questions: t.questions, percentCorrect: t.percentCorrect })),
        items,
      },
      null,
      1,
    );
  }

  return {
    status() {
      return {
        enabled,
        provider: provider.name,
        model: provider.model,
        message: enabled ? 'AI features are available.' : 'AI is not configured (pending configuration). Set ANTHROPIC_API_KEY on the server to enable it.',
      };
    },

    usage(teacherId) {
      const recent = db
        .prepare('SELECT feature, status, created_at, cost_usd FROM ai_requests WHERE teacher_id = ? ORDER BY id DESC LIMIT 20')
        .all(teacherId) as { feature: string; status: string; created_at: string; cost_usd: number }[];
      return {
        today: todayCount(teacherId),
        dailyLimit: config.AI_DAILY_REQUESTS_PER_TEACHER,
        monthCostUsd: Math.round(monthCost() * 10000) / 10000,
        monthBudgetUsd: config.AI_MONTHLY_BUDGET_USD,
        recent: recent.map((r) => ({ feature: r.feature, status: r.status, createdAt: r.created_at, costUsd: Math.round(r.cost_usd * 10000) / 10000 })),
      };
    },

    async insights(teacherId, sessionId, input) {
      if (input.stats.count < 1) throw new AppError(400, 'NO_RESULTS', 'Save at least one result before requesting insights.');
      const topicNames = input.topics.map((t) => t.topic);
      const prompt = `Analyse this anonymised class result and write insights for the teacher.
${topicNames.length ? 'Only use topic names from "topicsTaggedByTeacher" in topicsToReview.' : 'The teacher did not tag topics, so leave topicsToReview empty and refer to question numbers instead.'}
${input.stats.count < 10 ? `Only ${input.stats.count} student(s) were graded; say that patterns are tentative in "caveats".` : ''}
When question text is missing, do not guess what a question is about; describe it only by number and statistics.

DATA:
${describeSession(input)}`;
      const { id, output } = await run(
        teacherId,
        'insights',
        { sessionId },
        () => provider.generate({ feature: 'insights', system: SYSTEM_BASE, prompt, schema: insightsSchema, maxTokens: 6000, effort: 'medium' }),
        (d) => validateInsights(d, input.quiz.questionCount, topicNames),
      );
      return { id, insights: output as Insights };
    },

    async practice(teacherId, sessionId, input, choiceCount) {
      if (input.stats.count < 1) throw new AppError(400, 'NO_RESULTS', 'Save at least one result before requesting practice recommendations.');
      const weak = input.items.filter((i) => !i.excluded && i.percentCorrect !== null && i.percentCorrect < 70).sort((a, b) => (a.percentCorrect ?? 0) - (b.percentCorrect ?? 0)).slice(0, 8);
      const hasContent = weak.some((w) => w.topic || input.questionText.get(w.number)?.prompt);
      const prompt = `Suggest follow-up practice for the weakest items in this anonymised class result.
Weakest questions (below 70% correct): ${weak.map((w) => w.number).join(', ') || 'none'}.
${hasContent ? `Write up to 6 new multiple-choice practice questions with exactly ${choiceCount} options that target the same skills as those weak questions (use their text/topics). Do not copy the original questions.` : 'Question text and topics are not available, so return an empty practiceQuestions list and give general review strategies tied to question numbers.'}
Recommendations should be practical classroom activities (e.g. targeted mini-lesson, worked examples, peer discussion of the most common wrong answer).

DATA:
${describeSession(input)}`;
      const { id, output } = await run(
        teacherId,
        'practice',
        { sessionId },
        () => provider.generate({ feature: 'practice', system: SYSTEM_BASE, prompt, schema: practiceSchema, maxTokens: 8000, effort: 'medium' }),
        (d) => {
          const v = validateGeneratedQuestions(hasContent ? d.practiceQuestions : [], choiceCount, 6);
          const validQ = (n: number) => n >= 1 && n <= input.quiz.questionCount;
          return {
            recommendations: d.recommendations.slice(0, 6).map((r) => ({
              focus: r.focus.trim().slice(0, 200),
              activity: r.activity.trim().slice(0, 800),
              rationale: r.rationale.trim().slice(0, 400),
              questions: r.questions.filter(validQ),
            })),
            questions: v.valid,
            rejected: v.rejected.length,
          };
        },
      );
      return { id, ...(output as { recommendations: { focus: string; activity: string; rationale: string; questions: number[] }[]; questions: GeneratedQuestion[]; rejected: number }) };
    },

    async questions(teacherId, p) {
      const prompt = `Write ${p.count} multiple-choice questions.
Subject: ${p.subject}
Topic: ${p.topic}
Grade level: ${p.gradeLevel}
Difficulty: ${p.difficulty}
Options per question: exactly ${p.choiceCount}
${p.objectives ? `Learning objectives:\n${scrubPersonalData(p.objectives)}` : ''}
${p.language ? `Language: ${p.language}` : ''}
Vary which option is correct. Use the given topic (or a sub-topic of it) as each question's topic label.`;
      const { id, output } = await run(
        teacherId,
        'questions',
        {},
        () => provider.generate({ feature: 'questions', system: SYSTEM_BASE, prompt, schema: questionSetSchema, maxTokens: Math.min(16000, 1200 + p.count * 450), effort: 'medium' }),
        (d) => validateGeneratedQuestions(d.questions, p.choiceCount, p.count),
      );
      const v = output as { valid: GeneratedQuestion[]; rejected: { index: number; reason: string }[] };
      return { id, questions: v.valid, rejected: v.rejected };
    },

    async explain(teacherId, quizId, q) {
      const prompt = `Explain this multiple-choice question for a teacher: why the correct answer is right and why each other option is wrong. Add one short teaching tip.
${q.subject ? `Subject: ${q.subject}\n` : ''}Question ${q.number}: ${q.prompt}
${q.choices.map((c, i) => `${choiceLetter(i)}. ${c}`).join('\n')}
Correct answer (from the teacher's answer key): ${choiceLetter(q.correctChoice)}
If you believe the key may be wrong or the question is ambiguous, say so clearly in correctExplanation instead of inventing a justification.`;
      const { id, output } = await run(
        teacherId,
        'explanation',
        { quizId },
        () => provider.generate({ feature: 'explanation', system: SYSTEM_BASE, prompt, schema: explanationSchema, maxTokens: 3000, effort: 'low' }),
        (d) => validateExplanation(d, q.choices.length, q.correctChoice),
      );
      return { id, explanation: output as Explanation };
    },

    async quizDraft(teacherId, p) {
      const material = p.material ? scrubPersonalData(p.material).slice(0, 30_000) : null;
      const prompt = `Draft a ${p.questionCount}-item multiple-choice quiz with exactly ${p.choiceCount} options per item.
Subject: ${p.subject}
Grade level: ${p.gradeLevel}
Difficulty: ${p.difficulty}
${p.title ? `Working title: ${p.title}\n` : ''}${p.objectives ? `Learning objectives:\n${scrubPersonalData(p.objectives)}\n` : ''}${
        material
          ? `Base every question on the teaching material below; do not test facts that are not in it.\n<material>\n${material}\n</material>`
          : 'No material was provided; keep to well-established content for this subject and level.'
      }
Spread items across the objectives, vary which option is correct, and give each item a short topic label.`;
      const { id, output } = await run(
        teacherId,
        'quiz_draft',
        {},
        () => provider.generate({ feature: 'quiz_draft', system: SYSTEM_BASE, prompt, schema: quizDraftSchema, maxTokens: Math.min(16000, 1500 + p.questionCount * 450), effort: 'medium' }),
        (d) => {
          const v = validateGeneratedQuestions(d.questions, p.choiceCount, p.questionCount);
          return { title: (d.title || p.title || `${p.subject} quiz`).trim().slice(0, 160), subject: (d.subject || p.subject).trim().slice(0, 100), questions: v.valid, rejected: v.rejected };
        },
      );
      return { id, ...(output as { title: string; subject: string; questions: GeneratedQuestion[]; rejected: { index: number; reason: string }[] }) };
    },
  };
}
