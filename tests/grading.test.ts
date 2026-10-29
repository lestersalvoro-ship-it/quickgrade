import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, gradeSubmission, validateAnswerKey, type KeyQuestion, type ResponseInput } from '../shared/grading';
import { itemAnalysis, passRate, scoreDistribution, summarize, topicBreakdown } from '../shared/analytics';
import { classifyBubbles, calibrate, relativeFills } from '../server/src/scanner/classify';
import { decodeSheetCode, encodeSheetCode } from '../shared/sheet/code';
import { computeSheetLayout, columnCountFor } from '../shared/sheet/layout';

const key = (answers: (number | null)[], extra: Partial<KeyQuestion>[] = []): KeyQuestion[] =>
  answers.map((a, i) => ({ number: i + 1, correctChoice: a, points: 1, excluded: false, ...(extra[i] ?? {}) }));
const ans = (choices: (number | null | 'multi')[]): ResponseInput[] =>
  choices.map((c, i) =>
    c === 'multi' ? { number: i + 1, status: 'multiple', choice: null, marked: [0, 1] } : c === null ? { number: i + 1, status: 'blank', choice: null } : { number: i + 1, status: 'answered', choice: c },
  );

describe('grading engine', () => {
  it('scores correct answers and percentages', () => {
    const r = gradeSubmission(key([0, 1, 2, 3]), DEFAULT_RULES, ans([0, 1, 2, 0]));
    expect(r).toMatchObject({ rawScore: 3, totalPoints: 4, percent: 75, correctCount: 3, incorrectCount: 1, blankCount: 0, passed: true });
  });

  it('treats blanks as zero and counts them separately', () => {
    const r = gradeSubmission(key([0, 1, 2]), DEFAULT_RULES, ans([0, null, null]));
    expect(r).toMatchObject({ rawScore: 1, percent: 33.33, blankCount: 2, incorrectCount: 0, passed: false });
  });

  it('treats missing responses as blank', () => {
    const r = gradeSubmission(key([0, 1]), DEFAULT_RULES, [{ number: 1, status: 'answered', choice: 0 }]);
    expect(r.blankCount).toBe(1);
    expect(r.percent).toBe(50);
  });

  it('never awards multiple-marked answers, even if one mark is correct', () => {
    const r = gradeSubmission(key([0, 1]), DEFAULT_RULES, ans(['multi', 1]));
    expect(r).toMatchObject({ rawScore: 1, multipleCount: 1, correctCount: 1 });
    expect(r.questions[0].outcome).toBe('multiple');
  });

  it('excludes questions from both score and total', () => {
    const r = gradeSubmission(key([0, 1, 2, 3], [{}, { excluded: true }]), DEFAULT_RULES, ans([0, 3, 2, 3]));
    expect(r).toMatchObject({ rawScore: 3, totalPoints: 3, percent: 100, excludedCount: 1 });
  });

  it('supports weighted points', () => {
    const r = gradeSubmission(key([0, 1], [{ points: 3 }, { points: 1 }]), DEFAULT_RULES, ans([0, 0]));
    expect(r).toMatchObject({ rawScore: 3, totalPoints: 4, percent: 75 });
  });

  it('applies wrong-answer penalties and floors at zero', () => {
    const rules = { ...DEFAULT_RULES, wrongPenalty: 0.25 };
    expect(gradeSubmission(key([0, 0, 0, 0]), rules, ans([0, 0, 1, null])).rawScore).toBe(1.75);
    expect(gradeSubmission(key([0, 0]), rules, ans([1, 1])).rawScore).toBe(0);
    expect(gradeSubmission(key([0, 0]), { ...rules, floorAtZero: false }, ans([1, 1])).rawScore).toBe(-0.5);
    expect(gradeSubmission(key([0, 0]), { ...rules, penalizeBlank: true }, ans([0, null])).rawScore).toBe(0.75);
  });

  it('multiple policy "blank" removes the penalty for multiple marks', () => {
    const rules = { ...DEFAULT_RULES, wrongPenalty: 1, floorAtZero: false };
    expect(gradeSubmission(key([0, 0]), rules, ans([0, 'multi'])).rawScore).toBe(0);
    expect(gradeSubmission(key([0, 0]), { ...rules, multiplePolicy: 'blank' }, ans([0, 'multi'])).rawScore).toBe(1);
  });

  it('respects the pass threshold', () => {
    expect(gradeSubmission(key([0, 0, 0, 0]), { ...DEFAULT_RULES, passPercent: 75 }, ans([0, 0, 0, 1])).passed).toBe(true);
    expect(gradeSubmission(key([0, 0, 0, 0]), { ...DEFAULT_RULES, passPercent: 80 }, ans([0, 0, 0, 1])).passed).toBe(false);
  });

  it.each([20, 50, 100])('handles %i-question quizzes', (n) => {
    const k = key(Array.from({ length: n }, (_, i) => i % 4));
    const r = gradeSubmission(k, DEFAULT_RULES, ans(Array.from({ length: n }, (_, i) => (i < n / 2 ? i % 4 : (i + 1) % 4))));
    expect(r.totalPoints).toBe(n);
    expect(r.correctCount).toBe(n / 2);
    expect(r.percent).toBe(50);
  });

  it('refuses to grade an incomplete key', () => {
    expect(() => gradeSubmission(key([0, null]), DEFAULT_RULES, ans([0, 1]))).toThrow(/incomplete/);
  });
});

describe('answer key validation', () => {
  it('reports missing, out-of-range and duplicate entries', () => {
    expect(validateAnswerKey(key([0, 1, 2]), 3, 4)).toEqual([]);
    expect(validateAnswerKey(key([0, null, 2]), 3, 4)[0].message).toMatch(/no correct answer/);
    expect(validateAnswerKey(key([0, 4]), 2, 4)[0].message).toMatch(/invalid correct answer/);
    expect(validateAnswerKey(key([0]), 2, 4)[0].message).toMatch(/Expected 2/);
    expect(validateAnswerKey([...key([0]), ...key([1])], 2, 4).some((i) => /twice/.test(i.message))).toBe(true);
    expect(validateAnswerKey(key([null], [{ excluded: true }]), 1, 4).some((i) => /At least one/.test(i.message))).toBe(true);
    expect(validateAnswerKey(key([0], [{ points: 0 }]), 1, 4)[0].message).toMatch(/points/);
  });
});

describe('analytics', () => {
  it('summarises scores', () => {
    expect(summarize([50, 100, 75, 25])).toEqual({ count: 4, mean: 62.5, median: 62.5, min: 25, max: 100, stdDev: 27.95 });
    expect(summarize([]).mean).toBeNull();
    expect(passRate([80, 70, 75], 75)).toBe(66.67);
    expect(passRate([], 75)).toBeNull();
  });

  it('bins scores, including 100 and negatives', () => {
    const bins = scoreDistribution([100, 95, 0, -5, 49.9, 50]);
    expect(bins[9].count).toBe(2);
    expect(bins[0].count).toBe(2);
    expect(bins[4].count).toBe(1);
    expect(bins[5].count).toBe(1);
  });

  it('computes item statistics and distractors', () => {
    const subs = Array.from({ length: 10 }, (_, i) => ({
      percent: i * 10,
      responses: [
        { number: 1, status: 'answered' as const, choice: i >= 5 ? 0 : 2, isCorrect: i >= 5 },
        { number: 2, status: i === 0 ? ('blank' as const) : ('answered' as const), choice: i === 0 ? null : 1, isCorrect: i !== 0 },
      ],
    }));
    const items = itemAnalysis(
      [
        { number: 1, correctChoice: 0, excluded: false, topic: 'Fractions' },
        { number: 2, correctChoice: 1, excluded: false, topic: 'Decimals' },
      ],
      4,
      subs,
    );
    expect(items[0]).toMatchObject({ percentCorrect: 50, topDistractor: 2, choiceCounts: [5, 0, 5, 0], discrimination: 1 });
    expect(items[1]).toMatchObject({ percentCorrect: 90, blankCount: 1 });
    expect(topicBreakdown(items).map((t) => t.topic)).toEqual(['Fractions', 'Decimals']);
  });

  it('withholds the discrimination index for small groups', () => {
    const items = itemAnalysis([{ number: 1, correctChoice: 0, excluded: false }], 4, [{ percent: 100, responses: [{ number: 1, status: 'answered', choice: 0, isCorrect: true }] }]);
    expect(items[0].discrimination).toBeNull();
  });
});

describe('sheet code', () => {
  it('round-trips and rejects corruption', () => {
    const bits = encodeSheetCode({ version: 1, choiceCount: 4, questionCount: 50, quizCode: 123456 });
    expect(decodeSheetCode(bits)).toEqual({ ok: true, payload: { version: 1, choiceCount: 4, questionCount: 50, quizCode: 123456 } });
    for (let i = 4; i < bits.length; i++) {
      const flipped = [...bits];
      flipped[i] ^= 1;
      expect(decodeSheetCode(flipped).ok).toBe(false);
    }
    expect(decodeSheetCode([...bits].reverse()).ok).toBe(false);
  });

  it('lays out every supported length within the answer area', () => {
    for (let n = 1; n <= 100; n++) {
      for (let c = 2; c <= 5; c++) {
        const l = computeSheetLayout({ questionCount: n, choiceCount: c });
        expect(l.questions).toHaveLength(n);
        for (const q of l.questions) {
          for (const b of q.bubbles) {
            expect(b.x - b.r).toBeGreaterThan(-1);
            expect(b.x + b.r).toBeLessThan(181);
            expect(b.y + b.r).toBeLessThan(l.answerArea.y + l.answerArea.h);
          }
        }
      }
    }
    expect(columnCountFor(20)).toBe(2);
    expect(columnCountFor(100)).toBe(4);
    expect(() => computeSheetLayout({ questionCount: 101, choiceCount: 4 })).toThrow();
  });
});

describe('bubble classification', () => {
  const cal = calibrate(
    Array.from({ length: 20 }, (_, i) => [0.05, 0.05, i % 2 ? 0.9 : 0.85, 0.05]),
    0.95,
  );
  const rel = (raw: number[]) => relativeFills(raw, cal);
  it('accepts a clear single mark', () => expect(classifyBubbles(rel([0.05, 0.88, 0.05, 0.06]), cal)).toMatchObject({ status: 'ok', choice: 1 }));
  it('detects blanks', () => expect(classifyBubbles(rel([0.05, 0.06, 0.05, 0.07]), cal).status).toBe('blank'));
  it('detects multiple marks', () => expect(classifyBubbles(rel([0.85, 0.06, 0.8, 0.05]), cal)).toMatchObject({ status: 'multiple', marked: [0, 2] }));
  it('flags faint marks', () => expect(classifyBubbles(rel([0.05, 0.25, 0.05, 0.05]), cal).status).toBe('ambiguous'));
  it('flags a strong mark next to a heavy erasure', () => expect(classifyBubbles(rel([0.9, 0.05, 0.45, 0.05]), cal).status).toBe('ambiguous'));
});
