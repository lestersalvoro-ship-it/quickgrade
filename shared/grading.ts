/**
 * Deterministic grading engine. Official scores are always computed here from
 * the answer key and the teacher-confirmed responses — never by AI and never
 * from raw scanner confidences.
 */
import { CHOICE_LETTERS, MAX_CHOICES } from './sheet/layout';

export interface KeyQuestion {
  number: number;
  /** Correct choice index (0 = A). null means the key is incomplete for this item. */
  correctChoice: number | null;
  points: number;
  excluded: boolean;
}

export interface GradingRules {
  /** Points deducted for each incorrect answer (negative marking). 0 = none. */
  wrongPenalty: number;
  /** Whether the wrong-answer penalty also applies to blank answers. */
  penalizeBlank: boolean;
  /** How a confirmed multiple-marked answer is scored. */
  multiplePolicy: 'incorrect' | 'blank';
  /** Clamp negative totals to zero. */
  floorAtZero: boolean;
  /** Passing threshold, percent of total points. */
  passPercent: number;
}

export const DEFAULT_RULES: GradingRules = {
  wrongPenalty: 0,
  penalizeBlank: false,
  multiplePolicy: 'incorrect',
  floorAtZero: true,
  passPercent: 75,
};

export type ResponseStatus = 'answered' | 'blank' | 'multiple';

export interface ResponseInput {
  number: number;
  status: ResponseStatus;
  /** Chosen option when status = 'answered'. */
  choice: number | null;
  /** Options marked when status = 'multiple'. */
  marked?: number[];
}

export type QuestionOutcome = 'correct' | 'incorrect' | 'blank' | 'multiple' | 'excluded';

export interface GradedQuestion {
  number: number;
  status: ResponseStatus;
  choice: number | null;
  correctChoice: number | null;
  outcome: QuestionOutcome;
  isCorrect: boolean;
  pointsPossible: number;
  pointsAwarded: number;
}

export interface GradeResult {
  questions: GradedQuestion[];
  rawScore: number;
  totalPoints: number;
  percent: number;
  correctCount: number;
  incorrectCount: number;
  blankCount: number;
  multipleCount: number;
  excludedCount: number;
  passed: boolean;
}

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export interface KeyValidationIssue {
  number?: number;
  message: string;
}

/** Lists everything that prevents the key from being used for grading. */
export function validateAnswerKey(key: KeyQuestion[], questionCount: number, choiceCount: number): KeyValidationIssue[] {
  const issues: KeyValidationIssue[] = [];
  if (key.length !== questionCount) issues.push({ message: `Expected ${questionCount} questions but found ${key.length}.` });
  const seen = new Set<number>();
  for (const q of key) {
    if (seen.has(q.number)) issues.push({ number: q.number, message: `Question ${q.number} appears twice.` });
    seen.add(q.number);
    if (q.number < 1 || q.number > questionCount) issues.push({ number: q.number, message: `Question number ${q.number} is out of range.` });
    if (!(q.points > 0) || q.points > 100) issues.push({ number: q.number, message: `Question ${q.number} must be worth between 0 and 100 points.` });
    if (q.excluded) continue;
    if (q.correctChoice === null || q.correctChoice === undefined) {
      issues.push({ number: q.number, message: `Question ${q.number} has no correct answer.` });
    } else if (!Number.isInteger(q.correctChoice) || q.correctChoice < 0 || q.correctChoice >= choiceCount || q.correctChoice >= MAX_CHOICES) {
      issues.push({ number: q.number, message: `Question ${q.number} has an invalid correct answer for ${choiceCount} choices.` });
    }
  }
  if (key.length && key.every((q) => q.excluded)) issues.push({ message: 'At least one question must count toward the score.' });
  return issues;
}

export function gradeSubmission(key: KeyQuestion[], rules: GradingRules, responses: ResponseInput[]): GradeResult {
  const byNumber = new Map(responses.map((r) => [r.number, r]));
  const questions: GradedQuestion[] = [];
  let raw = 0;
  let total = 0;
  let correct = 0;
  let incorrect = 0;
  let blank = 0;
  let multiple = 0;
  let excluded = 0;

  for (const q of [...key].sort((a, b) => a.number - b.number)) {
    const r = byNumber.get(q.number) ?? { number: q.number, status: 'blank' as const, choice: null };
    let status: ResponseStatus = r.status;
    if (status === 'answered' && (r.choice === null || r.choice === undefined)) status = 'blank';
    const choice = status === 'answered' ? r.choice : null;

    if (q.excluded) {
      excluded++;
      questions.push({ number: q.number, status, choice, correctChoice: q.correctChoice, outcome: 'excluded', isCorrect: false, pointsPossible: 0, pointsAwarded: 0 });
      continue;
    }
    if (q.correctChoice === null) throw new Error(`Answer key incomplete: question ${q.number} has no correct answer`);
    total += q.points;

    let outcome: QuestionOutcome;
    let awarded = 0;
    if (status === 'answered') {
      if (choice === q.correctChoice) {
        outcome = 'correct';
        awarded = q.points;
        correct++;
      } else {
        outcome = 'incorrect';
        awarded = -rules.wrongPenalty;
        incorrect++;
      }
    } else if (status === 'multiple') {
      outcome = 'multiple';
      multiple++;
      const treatAsWrong = rules.multiplePolicy === 'incorrect';
      awarded = treatAsWrong || rules.penalizeBlank ? -rules.wrongPenalty : 0;
    } else {
      outcome = 'blank';
      blank++;
      awarded = rules.penalizeBlank ? -rules.wrongPenalty : 0;
    }
    raw += awarded;
    questions.push({ number: q.number, status, choice, correctChoice: q.correctChoice, outcome, isCorrect: outcome === 'correct', pointsPossible: q.points, pointsAwarded: round2(awarded) });
  }

  if (total <= 0) throw new Error('Cannot grade: no questions count toward the score');
  if (rules.floorAtZero && raw < 0) raw = 0;
  const rawScore = round2(raw);
  const percent = round2((raw / total) * 100);
  return {
    questions,
    rawScore,
    totalPoints: round2(total),
    percent,
    correctCount: correct,
    incorrectCount: incorrect,
    blankCount: blank,
    multipleCount: multiple,
    excludedCount: excluded,
    passed: percent >= rules.passPercent,
  };
}

export function choiceLetter(i: number | null | undefined): string {
  return i === null || i === undefined ? '—' : (CHOICE_LETTERS[i] ?? '?');
}

export function maskFromChoices(choices: number[]): number {
  return choices.reduce((m, c) => m | (1 << c), 0);
}

export function choicesFromMask(mask: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < MAX_CHOICES; i++) if (mask & (1 << i)) out.push(i);
  return out;
}
