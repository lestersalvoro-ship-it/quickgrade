import type { DB } from '../db/index';
import { gradeSubmission, validateAnswerKey, maskFromChoices, type GradeResult, type GradingRules, type KeyQuestion, type ResponseInput } from '../../../shared/grading';
import { AppError, conflict } from '../http';
import { audit } from './support';

export interface QuizRow {
  id: number;
  teacher_id: number;
  title: string;
  subject: string | null;
  description: string | null;
  instructions: string | null;
  question_count: number;
  choice_count: number;
  sheet_code: number;
  pass_percent: number | null;
  wrong_penalty: number;
  penalize_blank: number;
  multiple_policy: 'incorrect' | 'blank';
  floor_at_zero: number;
  source: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuestionRow {
  id: number;
  quiz_id: number;
  number: number;
  correct_choice: number | null;
  points: number;
  excluded: number;
  topic: string | null;
  prompt: string | null;
  choices_json: string | null;
  explanation: string | null;
}

export function rulesFor(quiz: QuizRow, defaultPassPercent: number): GradingRules {
  return {
    wrongPenalty: quiz.wrong_penalty,
    penalizeBlank: !!quiz.penalize_blank,
    multiplePolicy: quiz.multiple_policy,
    floorAtZero: !!quiz.floor_at_zero,
    passPercent: quiz.pass_percent ?? defaultPassPercent,
  };
}

export function keyFor(questions: QuestionRow[]): KeyQuestion[] {
  return questions.map((q) => ({ number: q.number, correctChoice: q.correct_choice, points: q.points, excluded: !!q.excluded }));
}

export function loadQuestions(db: DB, quizId: number): QuestionRow[] {
  return db.prepare('SELECT * FROM questions WHERE quiz_id = ? ORDER BY number').all(quizId) as QuestionRow[];
}

export function teacherPassDefault(db: DB, teacherId: number): number {
  return (db.prepare('SELECT default_pass_percent AS p FROM users WHERE id = ?').get(teacherId) as { p: number }).p;
}

/** Throws a 400 listing problems when the quiz cannot be used for grading yet. */
export function assertGradable(quiz: QuizRow, questions: QuestionRow[]) {
  const issues = validateAnswerKey(keyFor(questions), quiz.question_count, quiz.choice_count);
  if (issues.length) throw new AppError(400, 'ANSWER_KEY_INCOMPLETE', `The answer key for "${quiz.title}" is not ready: ${issues[0].message}`, issues);
}

export interface ResponseMeta {
  scannerStatus?: 'ok' | 'blank' | 'multiple' | 'ambiguous' | null;
  scannerConfidence?: number | null;
  teacherOverride?: boolean;
}

export type SubmissionResponse = ResponseInput & ResponseMeta;

function writeResponses(db: DB, submissionId: number, grade: GradeResult, responses: SubmissionResponse[]) {
  const byNumber = new Map(responses.map((r) => [r.number, r]));
  const ins = db.prepare(
    `INSERT INTO responses (submission_id, question_number, response_status, choice, marked_mask, is_correct, points_awarded, scanner_status, scanner_confidence, teacher_override)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const g of grade.questions) {
    const r = byNumber.get(g.number);
    const mask = g.status === 'multiple' ? maskFromChoices(r?.marked ?? []) : g.choice !== null ? 1 << g.choice : 0;
    ins.run(
      submissionId,
      g.number,
      g.status,
      g.choice,
      mask,
      g.isCorrect ? 1 : 0,
      g.pointsAwarded,
      r?.scannerStatus ?? null,
      r?.scannerConfidence ?? null,
      r?.teacherOverride ? 1 : 0,
    );
  }
}

export interface SaveSubmissionInput {
  teacherId: number;
  sessionId: number;
  studentId: number;
  source: 'scan' | 'manual';
  responses: SubmissionResponse[];
  replaceExisting: boolean;
}

/**
 * Grades and stores a submission atomically. A student has at most one result per
 * session; replacing an existing result is explicit and audited.
 */
export function saveSubmission(db: DB, quiz: QuizRow, questions: QuestionRow[], input: SaveSubmissionInput): { submissionId: number; grade: GradeResult; replaced: boolean } {
  assertGradable(quiz, questions);
  validateResponses(quiz, input.responses);
  const rules = rulesFor(quiz, teacherPassDefault(db, input.teacherId));
  const grade = gradeSubmission(keyFor(questions), rules, input.responses);
  return db.transaction(() => {
    const existing = db.prepare('SELECT id, percent FROM submissions WHERE session_id = ? AND student_id = ?').get(input.sessionId, input.studentId) as
      | { id: number; percent: number }
      | undefined;
    if (existing && !input.replaceExisting) {
      throw conflict('This student already has a saved result in this grading session.', { existingSubmissionId: existing.id });
    }
    if (existing) {
      db.prepare('UPDATE scans SET submission_id = NULL WHERE submission_id = ?').run(existing.id);
      db.prepare('DELETE FROM submissions WHERE id = ?').run(existing.id);
    }
    const edits = input.responses.filter((r) => r.teacherOverride).length;
    const info = db
      .prepare(
        `INSERT INTO submissions (session_id, student_id, source, raw_score, total_points, percent, correct_count, incorrect_count, blank_count, multiple_count, passed, teacher_edits)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.studentId,
        input.source,
        grade.rawScore,
        grade.totalPoints,
        grade.percent,
        grade.correctCount,
        grade.incorrectCount,
        grade.blankCount,
        grade.multipleCount,
        grade.passed ? 1 : 0,
        edits,
      );
    const submissionId = Number(info.lastInsertRowid);
    writeResponses(db, submissionId, grade, input.responses);
    audit(
      db,
      input.teacherId,
      'submission',
      submissionId,
      existing ? 'replace' : 'create',
      `${existing ? 'Replaced' : 'Saved'} result ${grade.rawScore}/${grade.totalPoints} (${grade.percent}%) via ${input.source}${edits ? `, ${edits} answer(s) corrected by teacher` : ''}`,
      { sessionId: input.sessionId, studentId: input.studentId, previousPercent: existing?.percent },
    );
    return { submissionId, grade, replaced: !!existing };
  })();
}

export function validateResponses(quiz: QuizRow, responses: ResponseInput[]) {
  const seen = new Set<number>();
  for (const r of responses) {
    if (!Number.isInteger(r.number) || r.number < 1 || r.number > quiz.question_count) throw new AppError(400, 'BAD_RESPONSE', `Question ${r.number} does not exist on this quiz.`);
    if (seen.has(r.number)) throw new AppError(400, 'BAD_RESPONSE', `Question ${r.number} was answered twice.`);
    seen.add(r.number);
    if (r.status === 'answered' && (r.choice === null || r.choice < 0 || r.choice >= quiz.choice_count)) {
      throw new AppError(400, 'BAD_RESPONSE', `Question ${r.number} has an invalid choice.`);
    }
    if (r.status !== 'answered' && r.choice !== null) throw new AppError(400, 'BAD_RESPONSE', `Question ${r.number}: only answered items may have a choice.`);
    if (r.status === 'multiple' && (r.marked ?? []).some((c) => c < 0 || c >= quiz.choice_count)) {
      throw new AppError(400, 'BAD_RESPONSE', `Question ${r.number} has invalid marked choices.`);
    }
  }
  if (seen.size !== quiz.question_count) throw new AppError(400, 'BAD_RESPONSE', `Provide a response (or blank) for all ${quiz.question_count} questions.`);
}

/** Loads saved responses of a submission as grading inputs. */
export function loadResponses(db: DB, submissionId: number): (SubmissionResponse & { isCorrect: boolean; pointsAwarded: number; markedMask: number })[] {
  const rows = db.prepare('SELECT * FROM responses WHERE submission_id = ? ORDER BY question_number').all(submissionId) as {
    question_number: number;
    response_status: 'answered' | 'blank' | 'multiple';
    choice: number | null;
    marked_mask: number;
    is_correct: number;
    points_awarded: number;
    scanner_status: ResponseMeta['scannerStatus'];
    scanner_confidence: number | null;
    teacher_override: number;
  }[];
  return rows.map((r) => ({
    number: r.question_number,
    status: r.response_status,
    choice: r.choice,
    marked: [0, 1, 2, 3, 4].filter((i) => r.marked_mask & (1 << i)),
    markedMask: r.marked_mask,
    isCorrect: !!r.is_correct,
    pointsAwarded: r.points_awarded,
    scannerStatus: r.scanner_status,
    scannerConfidence: r.scanner_confidence,
    teacherOverride: !!r.teacher_override,
  }));
}

/**
 * Recomputes every saved result for a quiz (after an answer-key, points, exclusion
 * or rule change). Runs inside the caller's transaction.
 */
export function regradeQuiz(db: DB, quiz: QuizRow, questions: QuestionRow[]): number {
  const subs = db
    .prepare('SELECT s.id FROM submissions s JOIN grading_sessions g ON g.id = s.session_id WHERE g.quiz_id = ?')
    .all(quiz.id) as { id: number }[];
  if (!subs.length) return 0;
  assertGradable(quiz, questions);
  const rules = rulesFor(quiz, teacherPassDefault(db, quiz.teacher_id));
  const key = keyFor(questions);
  const upd = db.prepare(
    `UPDATE submissions SET raw_score = ?, total_points = ?, percent = ?, correct_count = ?, incorrect_count = ?, blank_count = ?, multiple_count = ?, passed = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
  );
  const updResp = db.prepare('UPDATE responses SET is_correct = ?, points_awarded = ? WHERE submission_id = ? AND question_number = ?');
  for (const s of subs) {
    const responses = loadResponses(db, s.id);
    const g = gradeSubmission(key, rules, responses);
    upd.run(g.rawScore, g.totalPoints, g.percent, g.correctCount, g.incorrectCount, g.blankCount, g.multipleCount, g.passed ? 1 : 0, s.id);
    for (const q of g.questions) updResp.run(q.isCorrect ? 1 : 0, q.pointsAwarded, s.id, q.number);
  }
  return subs.length;
}
