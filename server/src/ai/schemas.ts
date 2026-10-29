import { z } from 'zod';

/** Model-facing schemas are deliberately simple; strict rules are enforced afterwards in validate*(). */

export const generatedQuestionSchema = z.object({
  prompt: z.string().describe('The question stem, self-contained, without the answer choices.'),
  choices: z.array(z.string()).describe('Answer options in order, without letter prefixes such as "A."'),
  correctIndex: z.number().int().describe('Zero-based index of the single correct option.'),
  explanation: z.string().describe('Why the correct option is right and why the others are wrong, 1–3 sentences.'),
  topic: z.string().describe('Short topic label for this question.'),
});
export type GeneratedQuestion = z.infer<typeof generatedQuestionSchema>;

export const questionSetSchema = z.object({ questions: z.array(generatedQuestionSchema) });

export const quizDraftSchema = z.object({
  title: z.string(),
  subject: z.string(),
  questions: z.array(generatedQuestionSchema),
});

export const insightsSchema = z.object({
  summary: z.string().describe('2–4 sentence overview of class performance for the teacher.'),
  strengths: z.array(z.object({ point: z.string(), questions: z.array(z.number().int()) })),
  difficulties: z.array(z.object({ point: z.string(), questions: z.array(z.number().int()), evidence: z.string() })),
  answerPatterns: z.array(z.object({ question: z.number().int(), observation: z.string() })),
  topicsToReview: z.array(z.object({ topic: z.string(), reason: z.string() })),
  suggestedActivities: z.array(z.object({ title: z.string(), description: z.string() })),
  caveats: z.array(z.string()),
});
export type Insights = z.infer<typeof insightsSchema>;

export const practiceSchema = z.object({
  recommendations: z.array(z.object({ focus: z.string(), activity: z.string(), rationale: z.string(), questions: z.array(z.number().int()) })),
  practiceQuestions: z.array(generatedQuestionSchema),
});
export type Practice = z.infer<typeof practiceSchema>;

export const explanationSchema = z.object({
  correctExplanation: z.string(),
  distractors: z.array(z.object({ choiceIndex: z.number().int(), whyIncorrect: z.string() })),
  teachingTip: z.string(),
});
export type Explanation = z.infer<typeof explanationSchema>;

// ---------------------------------------------------------------------------
// Post-validation

export interface QuestionValidation {
  valid: GeneratedQuestion[];
  rejected: { index: number; reason: string }[];
}

const stripLetter = (s: string) => s.replace(/^\s*(?:\(?[A-Ea-e][).:]\s+)/, '').trim();

export function validateGeneratedQuestions(input: GeneratedQuestion[], choiceCount: number, max: number): QuestionValidation {
  const valid: GeneratedQuestion[] = [];
  const rejected: { index: number; reason: string }[] = [];
  const seenPrompts = new Set<string>();
  input.slice(0, max).forEach((q, index) => {
    const prompt = (q.prompt ?? '').trim();
    const choices = (q.choices ?? []).map((c) => stripLetter(String(c)));
    const reason = (() => {
      if (prompt.length < 5 || prompt.length > 1000) return 'question text missing or too long';
      if (choices.length !== choiceCount) return `expected ${choiceCount} options, got ${choices.length}`;
      if (choices.some((c) => !c || c.length > 300)) return 'an option is empty or too long';
      if (new Set(choices.map((c) => c.toLowerCase())).size !== choices.length) return 'duplicate options';
      if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= choiceCount) return 'correct answer index out of range';
      if (seenPrompts.has(prompt.toLowerCase())) return 'duplicate question';
      return null;
    })();
    if (reason) {
      rejected.push({ index, reason });
      return;
    }
    seenPrompts.add(prompt.toLowerCase());
    valid.push({
      prompt,
      choices,
      correctIndex: q.correctIndex,
      explanation: (q.explanation ?? '').trim().slice(0, 1500),
      topic: (q.topic ?? '').trim().slice(0, 100),
    });
  });
  return { valid, rejected };
}

export function validateInsights(raw: Insights, questionCount: number, knownTopics: string[]): Insights {
  const validQ = (n: number) => Number.isInteger(n) && n >= 1 && n <= questionCount;
  const topicSet = new Map(knownTopics.map((t) => [t.toLowerCase(), t]));
  const clip = (s: string, n: number) => (s ?? '').trim().slice(0, n);
  return {
    summary: clip(raw.summary, 1500),
    strengths: raw.strengths.slice(0, 6).map((s) => ({ point: clip(s.point, 400), questions: s.questions.filter(validQ) })),
    difficulties: raw.difficulties.slice(0, 8).map((d) => ({ point: clip(d.point, 400), questions: d.questions.filter(validQ), evidence: clip(d.evidence, 400) })),
    answerPatterns: raw.answerPatterns.filter((p) => validQ(p.question)).slice(0, 10).map((p) => ({ question: p.question, observation: clip(p.observation, 400) })),
    // Only topics the teacher actually tagged are allowed; anything invented is dropped.
    topicsToReview: raw.topicsToReview
      .filter((t) => topicSet.has(t.topic.trim().toLowerCase()))
      .slice(0, 8)
      .map((t) => ({ topic: topicSet.get(t.topic.trim().toLowerCase())!, reason: clip(t.reason, 400) })),
    suggestedActivities: raw.suggestedActivities.slice(0, 6).map((a) => ({ title: clip(a.title, 120), description: clip(a.description, 600) })),
    caveats: raw.caveats.slice(0, 5).map((c) => clip(c, 300)),
  };
}

export function validateExplanation(raw: Explanation, choiceCount: number, correct: number): Explanation {
  return {
    correctExplanation: raw.correctExplanation.trim().slice(0, 1500),
    distractors: raw.distractors
      .filter((d) => Number.isInteger(d.choiceIndex) && d.choiceIndex >= 0 && d.choiceIndex < choiceCount && d.choiceIndex !== correct)
      .map((d) => ({ choiceIndex: d.choiceIndex, whyIncorrect: d.whyIncorrect.trim().slice(0, 800) })),
    teachingTip: raw.teachingTip.trim().slice(0, 800),
  };
}

/** Removes obvious personal identifiers from teacher-supplied material before it leaves the server. */
export function scrubPersonalData(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email removed]')
    .replace(/(?:\+?\d[\d\s-]{9,}\d)/g, '[number removed]');
}
