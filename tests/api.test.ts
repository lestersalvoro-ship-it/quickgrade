import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { Client, registerTeacher, startServer, type TestServer } from './helpers/api';
import { hasPdftoppm, photograph, renderFilledSheet, type Mark } from './helpers/synthetic';
import { AiError, type AiProvider, type AiRequest, type AiResult } from '../server/src/ai/provider';

const KEY = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3];

async function makeQuiz(c: Client, overrides: Record<string, unknown> = {}) {
  const r = await c.post('/api/quizzes', {
    title: 'Science Quiz 1',
    subject: 'Science',
    questionCount: 20,
    choiceCount: 4,
    questions: KEY.map((k, i) => ({ number: i + 1, correctChoice: k, points: 1, excluded: false, topic: i < 10 ? 'Matter' : 'Energy' })),
    ...overrides,
  });
  expect(r.status).toBe(201);
  return r.json.quiz;
}

async function makeClassWithStudents(c: Client) {
  const cls = (await c.post('/api/classes', { name: 'Grade 8', section: 'Rizal' })).json.class;
  const students = [];
  for (const [num, first, last] of [
    ['1001', 'Ana', 'Santos'],
    ['1002', 'Ben', 'Reyes'],
    ['1003', 'Carla', 'Cruz'],
  ]) {
    const r = await c.post('/api/students', { studentNumber: num, firstName: first, lastName: last, classIds: [cls.id] });
    expect(r.status).toBe(201);
    students.push(r.json.student);
  }
  return { cls, students };
}

describe('authentication and sessions', () => {
  let s: TestServer;
  beforeAll(async () => (s = await startServer()));
  afterAll(() => s.close());

  it('registers, signs in and out', async () => {
    const c = new Client(s.app);
    expect((await c.get('/api/auth/me')).status).toBe(401);
    const reg = await c.post('/api/auth/register', { email: 'Maria@School.test', password: 'tamang password 7', fullName: 'Maria Clara' });
    expect(reg.status).toBe(201);
    expect(reg.json.user.email).toBe('maria@school.test');
    expect((await c.get('/api/auth/me')).json.user.fullName).toBe('Maria Clara');
    await c.post('/api/auth/logout');
    expect((await c.get('/api/auth/me')).status).toBe(401);
    expect((await c.post('/api/auth/login', { email: 'maria@school.test', password: 'wrong password 1' })).status).toBe(401);
    expect((await c.post('/api/auth/login', { email: 'maria@school.test', password: 'tamang password 7' })).status).toBe(200);
    expect((await c.get('/api/auth/me')).status).toBe(200);
  });

  it('stores only a password hash and a hashed session token', async () => {
    const c = new Client(s.app);
    await c.post('/api/auth/register', { email: 'hash@school.test', password: 'secret phrase 99', fullName: 'H' });
    const row = s.ctx.db.prepare('SELECT password_hash FROM users WHERE email = ?').get('hash@school.test') as { password_hash: string };
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain('secret phrase');
    const token = c.cookie.split('=')[1];
    expect(s.ctx.db.prepare('SELECT 1 FROM auth_sessions WHERE token_hash = ?').get(token)).toBeUndefined();
  });

  it('rejects weak passwords and duplicate emails', async () => {
    const c = new Client(s.app);
    expect((await c.post('/api/auth/register', { email: 'weak@school.test', password: 'short', fullName: 'W' })).json.error.code).toBe('WEAK_PASSWORD');
    await c.post('/api/auth/register', { email: 'dup@school.test', password: 'long enough 123', fullName: 'D' });
    expect((await new Client(s.app).post('/api/auth/register', { email: 'dup@school.test', password: 'long enough 123', fullName: 'D' })).status).toBe(409);
  });

  it('requires the CSRF header on state-changing requests', async () => {
    const res = await s.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@y.z', password: 'abc' } });
    expect(res.statusCode).toBe(403);
  });

  it('resets a password with a one-time emailed token', async () => {
    const c = new Client(s.app);
    await c.post('/api/auth/register', { email: 'reset@school.test', password: 'original pass 1', fullName: 'R' });
    expect((await new Client(s.app).post('/api/auth/forgot-password', { email: 'nobody@school.test' })).status).toBe(200);
    expect(s.mail).toHaveLength(0);
    await new Client(s.app).post('/api/auth/forgot-password', { email: 'reset@school.test' });
    const token = decodeURIComponent(/token=([^\s]+)/.exec(s.mail[0].text)![1]);
    const r = await new Client(s.app).post('/api/auth/reset-password', { token, password: 'brand new pass 2' });
    expect(r.status).toBe(200);
    // Old sessions are revoked, token cannot be reused, new password works.
    expect((await c.get('/api/auth/me')).status).toBe(401);
    expect((await new Client(s.app).post('/api/auth/reset-password', { token, password: 'another pass 3x' })).json.error.code).toBe('INVALID_TOKEN');
    expect((await new Client(s.app).post('/api/auth/login', { email: 'reset@school.test', password: 'brand new pass 2' })).status).toBe(200);
  });
});

describe('teacher data isolation', () => {
  let s: TestServer;
  beforeAll(async () => (s = await startServer()));
  afterAll(() => s.close());

  it('prevents one teacher from reading or modifying another teacher’s records', async () => {
    const a = (await registerTeacher(s.app, 'A')).client;
    const b = (await registerTeacher(s.app, 'B')).client;
    const quiz = await makeQuiz(a);
    const { cls, students } = await makeClassWithStudents(a);
    const session = (await a.post('/api/sessions', { quizId: quiz.id, classId: cls.id, name: 'Q1' })).json.session;
    const manual = await a.post(`/api/sessions/${session.id}/manual`, {
      studentId: students[0].id,
      responses: KEY.map((k, i) => ({ number: i + 1, status: 'answered', choice: k })),
    });
    expect(manual.status).toBe(201);

    for (const url of [
      `/api/quizzes/${quiz.id}`,
      `/api/classes/${cls.id}`,
      `/api/students/${students[0].id}`,
      `/api/sessions/${session.id}`,
      `/api/sessions/${session.id}/analytics`,
      `/api/submissions/${manual.json.submissionId}`,
      `/api/quizzes/${quiz.id}/sheets.pdf`,
      `/api/sessions/${session.id}/results.csv`,
    ]) {
      expect((await b.get(url)).status, url).toBe(404);
    }
    expect((await b.put(`/api/students/${students[0].id}`, { firstName: 'X', lastName: 'Y' })).status).toBe(404);
    expect((await b.del(`/api/submissions/${manual.json.submissionId}`)).status).toBe(404);
    // B cannot attach A's student or quiz to its own class/session.
    const bClass = (await b.post('/api/classes', { name: 'B class' })).json.class;
    expect((await b.post(`/api/classes/${bClass.id}/enroll`, { studentIds: [students[0].id] })).status).toBe(404);
    expect((await b.post('/api/sessions', { quizId: quiz.id, classId: bClass.id, name: 'steal' })).status).toBe(404);
    // Lists only show own data.
    expect((await b.get('/api/students')).json.total).toBe(0);
    expect((await b.get('/api/quizzes')).json.quizzes).toHaveLength(0);
    expect((await b.get('/api/dashboard')).json.counts.results).toBe(0);
    expect((await a.get('/api/dashboard')).json.counts.results).toBe(1);
  });
});

describe('classes, students and CSV import', () => {
  let s: TestServer;
  let c: Client;
  beforeAll(async () => {
    s = await startServer();
    c = (await registerTeacher(s.app)).client;
  });
  afterAll(() => s.close());

  it('validates and deduplicates student numbers', async () => {
    expect((await c.post('/api/students', { studentNumber: '00042', firstName: 'Zed', lastName: 'Zero' })).json.student.studentNumber).toBe('42');
    expect((await c.post('/api/students', { studentNumber: '42', firstName: 'Dup', lastName: 'Licate' })).status).toBe(409);
    expect((await c.post('/api/students', { studentNumber: '12ab', firstName: 'Bad', lastName: 'Id' })).status).toBe(400);
    expect((await c.post('/api/students', { studentNumber: '123456789', firstName: 'Too', lastName: 'Long' })).status).toBe(400);
    const auto = await c.post('/api/students', { firstName: 'Auto', lastName: 'Number' });
    expect(auto.json.student.studentNumber).toBe('1001');
  });

  it('previews and imports a roster CSV with errors reported per line', async () => {
    const cls = (await c.post('/api/classes', { name: 'Grade 9', section: 'Mabini' })).json.class;
    const csv = 'Student No.,Last Name,First Name,LRN\n2001,Dela Cruz,Juan,123456789012\n2002,Reyes,Maria,\n2002,Twin,Dup,\nabc,Bad,Number,\n,Garcia,Luis,\n42,Zero,Zed,\n';
    const preview = await c.post('/api/students/import', { csv, classId: cls.id, dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.json.errors.map((e: { line: number }) => e.line)).toEqual([4, 5]);
    expect(preview.json.created).toBe(3);
    expect(preview.json.skipped).toBe(1); // 42 already exists
    // Committing with errors is refused.
    expect((await c.post('/api/students/import', { csv, classId: cls.id, dryRun: false })).status).toBe(400);
    const clean = csv.split('\n').filter((_, i) => i !== 3 && i !== 4).join('\n');
    const done = await c.post('/api/students/import', { csv: clean, classId: cls.id, dryRun: false, onExisting: 'update' });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ created: 3, updated: 1, enrolled: 4 });
    const roster = (await c.get(`/api/classes/${cls.id}`)).json;
    expect(roster.students.map((x: { lastName: string }) => x.lastName).sort()).toEqual(['Dela Cruz', 'Garcia', 'Reyes', 'Zero']);
    const exported = await c.get(`/api/classes/${cls.id}/export.csv`);
    expect(exported.body.toString()).toContain('2001,Dela Cruz,Juan,123456789012');
  });

  it('rejects malformed CSV files gracefully', async () => {
    expect((await c.post('/api/students/import', { csv: 'foo,bar\n1,2', dryRun: true })).json.errors[0].message).toMatch(/Missing name columns/);
    expect((await c.post('/api/students/import', { csv: '"unterminated,quote\n', dryRun: true })).json.errors[0].message).toMatch(/not valid CSV/);
  });

  it('guards against spreadsheet formula injection in exports', async () => {
    await c.post('/api/students', { firstName: '=HYPERLINK("x")', lastName: 'Evil' });
    const csv = (await c.get('/api/students/export.csv')).body.toString();
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('prevents duplicate active classes', async () => {
    await c.post('/api/classes', { name: 'Unique', section: 'A' });
    expect((await c.post('/api/classes', { name: 'unique', section: 'a' })).status).toBe(409);
  });
});

describe('quiz and answer key management', () => {
  let s: TestServer;
  let c: Client;
  beforeAll(async () => {
    s = await startServer();
    c = (await registerTeacher(s.app)).client;
  });
  afterAll(() => s.close());

  it('rejects invalid configurations', async () => {
    expect((await c.post('/api/quizzes', { title: 'x', questionCount: 0, choiceCount: 4 })).status).toBe(400);
    expect((await c.post('/api/quizzes', { title: 'x', questionCount: 101, choiceCount: 4 })).status).toBe(400);
    expect((await c.post('/api/quizzes', { title: 'x', questionCount: 10, choiceCount: 6 })).status).toBe(400);
    const bad = await c.post('/api/quizzes', { title: 'x', questionCount: 2, choiceCount: 3, questions: [{ number: 1, correctChoice: 3 }] });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/not available with 3 choices/);
    expect((await c.post('/api/quizzes', { title: 'x', questionCount: 2, choiceCount: 4, questions: [{ number: 3, correctChoice: 0 }] })).status).toBe(400);
  });

  it('marks incomplete keys and blocks grading until complete', async () => {
    const q = await makeQuiz(c, { questions: [{ number: 1, correctChoice: 0 }] });
    expect(q.keyComplete).toBe(false);
    expect(q.keyIssues.length).toBeGreaterThan(0);
    const cls = (await c.post('/api/classes', { name: 'K' })).json.class;
    const st = (await c.post('/api/students', { firstName: 'A', lastName: 'B', classIds: [cls.id] })).json.student;
    const session = (await c.post('/api/sessions', { quizId: q.id, classId: cls.id, name: 'S' })).json.session;
    const r = await c.post(`/api/sessions/${session.id}/manual`, { studentId: st.id, responses: [{ number: 1, status: 'answered', choice: 0 }] });
    expect(r.json.error.code).toBe('ANSWER_KEY_INCOMPLETE');
  });

  it('duplicates, archives and generates printable sheets and keys', async () => {
    const q = await makeQuiz(c);
    const dup = (await c.post(`/api/quizzes/${q.id}/duplicate`)).json.quiz;
    expect(dup.title).toBe('Science Quiz 1 (copy)');
    expect(dup.sheetCode).not.toBe(q.sheetCode);
    expect(dup.questions.map((x: { correctChoice: number }) => x.correctChoice)).toEqual(KEY);
    expect((await c.post(`/api/quizzes/${dup.id}/archive`, { archived: true })).json.quiz.archived).toBe(true);
    const pdf = await c.get(`/api/quizzes/${q.id}/sheets.pdf?paper=LETTER&copies=3`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect((pdf.body.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBe(3);
    const key = await c.get(`/api/quizzes/${q.id}/key.pdf`);
    expect(key.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await c.get(`/api/quizzes/${q.id}/key.csv`)).body.toString()).toContain('1,A,1,no,Matter');
  });

  it('issues a new sheet code when the layout changes before grading', async () => {
    const q = await makeQuiz(c);
    const r = await c.put(`/api/quizzes/${q.id}`, { ...q, questionCount: 25, questions: q.questions });
    expect(r.status).toBe(200);
    expect(r.json.structureChanged).toBe(true);
    expect(r.json.quiz.sheetCode).not.toBe(q.sheetCode);
  });
});

const d = hasPdftoppm() ? describe : describe.skip;

d('end-to-end: scan, review, confirm, analytics', () => {
  let s: TestServer;
  let c: Client;
  let quiz: any;
  let cls: any;
  let students: any[];
  let session: any;
  let photo: Buffer;

  beforeAll(async () => {
    s = await startServer();
    c = (await registerTeacher(s.app)).client;
    quiz = await makeQuiz(c);
    ({ cls, students } = await makeClassWithStudents(c));
    session = (await c.post('/api/sessions', { quizId: quiz.id, classId: cls.id, name: 'Quiz 1 – Rizal', heldOn: '2026-10-28' })).json.session;
    // Student 1002 answers 1–16 correctly, 17–18 wrong, 19 blank, 20 double-marked.
    const marks: Mark[] = KEY.slice(0, 18).map((k, i) => ({ question: i + 1, choice: i < 16 ? k : (k + 1) % 4, style: 'pencil' }));
    marks.push({ question: 20, choice: 0, style: 'pencil' }, { question: 20, choice: 3, style: 'pencil' });
    '1002'.split('').forEach((dgt, i) => marks.push({ idDigit: { column: i, digit: Number(dgt) }, style: 'pencil' }));
    const sheet = await renderFilledSheet({ questionCount: 20, choiceCount: 4, sheetCode: quiz.sheetCode, marks });
    photo = await photograph(sheet.png, { rotate: 6, perspective: 0.5, dimSide: 0.6, noise: 5 });
  });
  afterAll(() => s.close());

  it('scans the uploaded photo and matches the student', async () => {
    const r = await c.upload(`/api/sessions/${session.id}/scans`, 'sheet.jpg', photo);
    expect(r.status).toBe(201);
    expect(r.json.result.ok).toBe(true);
    expect(r.json.matchedStudent).toMatchObject({ studentNumber: '1002', enrolled: true });
    expect(r.json.result.flaggedCount).toBe(1);
    expect(r.json.result.answers[19].status).toBe('multiple');
    expect(r.json.result.answers[18].status).toBe('blank');
    expect((await c.get(`/api/scans/${r.json.scan.id}/image`)).headers['content-type']).toBe('image/jpeg');
    session.scanId = r.json.scan.id;
    session.answers = r.json.result.answers;
  });

  it('rejects the same photo twice', async () => {
    const r = await c.upload(`/api/sessions/${session.id}/scans`, 'sheet.jpg', photo);
    expect(r.status).toBe(409);
  });

  it('refuses to save until flagged answers are reviewed', async () => {
    const answers = session.answers.map((a: any) => ({
      number: a.question,
      status: a.status === 'ok' ? 'answered' : a.status === 'blank' ? 'blank' : 'multiple',
      choice: a.status === 'ok' ? a.choice : null,
      marked: a.marked,
    }));
    const r = await c.post(`/api/scans/${session.scanId}/confirm`, { studentId: students[1].id, answers });
    expect(r.json.error.code).toBe('UNREVIEWED_FLAGS');
    answers[19].reviewed = true;
    const ok = await c.post(`/api/scans/${session.scanId}/confirm`, { studentId: students[1].id, answers });
    expect(ok.status).toBe(200);
    expect(ok.json.grade).toMatchObject({ rawScore: 16, totalPoints: 20, percent: 80, correctCount: 16, incorrectCount: 2, blankCount: 1, multipleCount: 1, passed: true });
    // Confirming twice is impossible.
    expect((await c.post(`/api/scans/${session.scanId}/confirm`, { studentId: students[1].id, answers })).status).toBe(409);
  });

  it('prevents duplicate results for a student unless replacement is explicit', async () => {
    const responses = KEY.map((k, i) => ({ number: i + 1, status: 'answered', choice: k }));
    const dup = await c.post(`/api/sessions/${session.id}/manual`, { studentId: students[1].id, responses });
    expect(dup.status).toBe(409);
    const other = await c.post(`/api/sessions/${session.id}/manual`, { studentId: students[0].id, responses });
    expect(other.json.grade.percent).toBe(100);
  });

  it('produces analytics from saved results', async () => {
    const a = (await c.get(`/api/sessions/${session.id}/analytics`)).json.analytics;
    expect(a.stats).toMatchObject({ count: 2, mean: 90, median: 90, min: 80, max: 100 });
    expect(a.passRate).toBe(100);
    expect(a.items[16]).toMatchObject({ number: 17, percentCorrect: 50 });
    expect(a.topics.map((t: { topic: string }) => t.topic)).toEqual(['Energy', 'Matter']);
    const detail = (await c.get(`/api/sessions/${session.id}`)).json;
    expect(detail.missingStudents.map((m: { studentNumber: string }) => m.studentNumber)).toEqual(['1003']);
  });

  it('records teacher corrections with an audit trail', async () => {
    const sub = (await c.get(`/api/sessions/${session.id}`)).json.submissions.find((x: any) => x.student.studentNumber === '1002');
    const detail = (await c.get(`/api/submissions/${sub.id}`)).json;
    const responses = detail.questions.map((q: any) => ({ number: q.number, status: q.status, choice: q.choice, marked: q.marked }));
    responses[18] = { number: 19, status: 'answered', choice: KEY[18] };
    const r = await c.put(`/api/submissions/${sub.id}`, { responses, reason: 'Student wrote answer in margin' });
    expect(r.json.grade.rawScore).toBe(17);
    const after = (await c.get(`/api/submissions/${sub.id}`)).json;
    expect(after.submission.teacherEdits).toBeGreaterThanOrEqual(1);
    expect(after.history[0].summary).toMatch(/Corrected 1 answer/);
    expect(after.questions[18].teacherOverride).toBe(true);
  });

  it('regrades saved results when the answer key changes', async () => {
    const q = (await c.get(`/api/quizzes/${quiz.id}`)).json.quiz;
    const questions = q.questions.map((x: any) => (x.number === 1 ? { ...x, excluded: true } : x));
    const r = await c.put(`/api/quizzes/${quiz.id}`, { ...q, questions });
    expect(r.json.regraded).toBe(2);
    const subs = (await c.get(`/api/sessions/${session.id}`)).json.submissions;
    expect(subs.every((x: any) => x.totalPoints === 19)).toBe(true);
    // Structure is locked once results exist.
    expect((await c.put(`/api/quizzes/${quiz.id}`, { ...q, questionCount: 30, questions })).status).toBe(409);
  });

  it('exports results as CSV and PDF', async () => {
    const csv = (await c.get(`/api/sessions/${session.id}/results.csv`)).body.toString();
    expect(csv.split('\n')[0]).toContain('student_number,last_name,first_name,score,total_points,percent');
    expect(csv).toContain('1002,Reyes,Ben,16,19');
    expect(csv).toContain('MULTI');
    const pdf = await c.get(`/api/sessions/${session.id}/report.pdf`);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await c.get(`/api/sessions/${session.id}/item-analysis.csv`)).body.toString()).toContain('question,key,excluded,percent_correct');
  });

  it('rejects sheets printed for a different quiz', async () => {
    const other = await makeQuiz(c, { title: 'Other quiz' });
    const sheet = await renderFilledSheet({ questionCount: 20, choiceCount: 4, sheetCode: other.sheetCode, marks: [{ question: 1, choice: 0, style: 'pen' }] });
    const r = await c.upload(`/api/sessions/${session.id}/scans`, 'other.jpg', await photograph(sheet.png));
    expect(r.status).toBe(422);
    expect(r.json.result.error.code).toBe('WRONG_QUIZ');
    expect(r.json.result.error.message).toContain('Other quiz');
  });

  it('reports unreadable uploads with guidance', async () => {
    const r = await c.upload(`/api/sessions/${session.id}/scans`, 'x.txt', Buffer.from('hello'), 'text/plain');
    expect(r.status).toBe(415);
  });
});

class FakeProvider implements AiProvider {
  readonly name = 'fake';
  readonly model = 'fake-model';
  prompts: string[] = [];
  next: unknown = null;
  fail: AiError | null = null;
  async generate<T>(req: AiRequest<T>): Promise<AiResult<T>> {
    this.prompts.push(req.system + '\n' + req.prompt);
    if (this.fail) throw this.fail;
    return { data: this.next as T, model: this.model, inputTokens: 1000, outputTokens: 500 };
  }
}

describe('AI integration', () => {
  it('reports AI as unavailable when not configured, without affecting grading', async () => {
    const s = await startServer();
    const c = (await registerTeacher(s.app)).client;
    const status = (await c.get('/api/ai/status')).json;
    expect(status.enabled).toBe(false);
    expect(status.message).toMatch(/pending configuration/);
    const r = await c.post('/api/ai/questions', { subject: 'Math', topic: 'Fractions', gradeLevel: 'Grade 5', count: 3 });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('AI_UNAVAILABLE');
    await s.close();
  });

  describe('with a provider', () => {
    let s: TestServer;
    let c: Client;
    const fake = new FakeProvider();
    beforeAll(async () => {
      s = await startServer({ aiProvider: fake, env: { AI_DAILY_REQUESTS_PER_TEACHER: '5' } });
      c = (await registerTeacher(s.app)).client;
    });
    afterAll(() => s.close());

    it('validates generated questions and drops invalid ones', async () => {
      fake.next = {
        questions: [
          { prompt: 'What is 1/2 + 1/4?', choices: ['A. 3/4', 'B. 2/6', 'C. 1/8', 'D. 2/4'], correctIndex: 0, explanation: 'Common denominators.', topic: 'Fractions' },
          { prompt: 'Too few options?', choices: ['1', '2'], correctIndex: 0, explanation: '', topic: 'x' },
          { prompt: 'Bad index', choices: ['a', 'b', 'c', 'd'], correctIndex: 7, explanation: '', topic: 'x' },
          { prompt: 'Duplicate options', choices: ['a', 'a', 'c', 'd'], correctIndex: 0, explanation: '', topic: 'x' },
        ],
      };
      const r = await c.post('/api/ai/questions', { subject: 'Math', topic: 'Fractions', gradeLevel: 'Grade 5', count: 4, choiceCount: 4 });
      expect(r.status).toBe(200);
      expect(r.json.questions).toHaveLength(1);
      expect(r.json.questions[0].choices).toEqual(['3/4', '2/6', '1/8', '2/4']);
      expect(r.json.rejected).toHaveLength(3);
    });

    it('sends only anonymised aggregates for insights and drops invented topics', async () => {
      const quiz = await makeQuiz(c);
      const { cls, students } = await makeClassWithStudents(c);
      const session = (await c.post('/api/sessions', { quizId: quiz.id, classId: cls.id, name: 'AI test' })).json.session;
      await c.post(`/api/sessions/${session.id}/manual`, { studentId: students[0].id, responses: KEY.map((k, i) => ({ number: i + 1, status: 'answered', choice: i < 5 ? (k + 1) % 4 : k })) });
      fake.next = {
        summary: 'Most students did well.',
        strengths: [{ point: 'Energy items', questions: [11, 12, 999] }],
        difficulties: [{ point: 'Items 1–5', questions: [1, 2, 3, 4, 5], evidence: '0% correct' }],
        answerPatterns: [{ question: 1, observation: 'All chose B' }, { question: 77, observation: 'invalid' }],
        topicsToReview: [{ topic: 'Matter', reason: 'low' }, { topic: 'Quantum Gravity', reason: 'invented' }],
        suggestedActivities: [{ title: 'Re-teach', description: 'Mini-lesson' }],
        caveats: ['Only one student'],
      };
      const r = await c.post(`/api/ai/sessions/${session.id}/insights`);
      expect(r.status).toBe(200);
      expect(r.json.insights.topicsToReview).toEqual([{ topic: 'Matter', reason: 'low' }]);
      expect(r.json.insights.strengths[0].questions).toEqual([11, 12]);
      expect(r.json.insights.answerPatterns).toHaveLength(1);
      const prompt = fake.prompts.at(-1)!;
      for (const st of students) {
        expect(prompt).not.toMatch(new RegExp(`\\b${st.firstName}\\b`));
        expect(prompt).not.toMatch(new RegExp(`\\b${st.lastName}\\b`));
        expect(prompt).not.toMatch(new RegExp(`\\b${st.studentNumber}\\b`));
      }
      const latest = (await c.get(`/api/ai/sessions/${session.id}/latest`)).json;
      expect(latest.insights.output.summary).toBe('Most students did well.');
      // Official scores are untouched by AI.
      expect((await c.get(`/api/sessions/${session.id}`)).json.submissions[0].percent).toBe(75);
    });

    it('maps provider failures to clear errors and records usage', async () => {
      fake.fail = new AiError('rate_limited', 'The AI service is busy right now.');
      const r = await c.post('/api/ai/questions', { subject: 'Math', topic: 'Fractions', gradeLevel: 'Grade 5', count: 2 });
      expect(r.status).toBe(429);
      expect(r.json.error.message).toMatch(/busy/);
      fake.fail = null;
      const usage = (await c.get('/api/ai/status')).json.usage;
      expect(usage.recent[0]).toMatchObject({ feature: 'questions', status: 'error' });
      expect(usage.monthCostUsd).toBeGreaterThan(0);
    });

    it('enforces the per-teacher daily limit', async () => {
      fake.next = { questions: [] };
      let last = 0;
      for (let i = 0; i < 5; i++) last = (await c.post('/api/ai/questions', { subject: 'M', topic: 'T', gradeLevel: 'G', count: 1 })).status;
      expect(last).toBe(429);
    });
  });
});

describe('persistence and account deletion', () => {
  it('keeps records across restarts and deletes everything on account deletion', async () => {
    const s1 = await startServer();
    const { client, email } = await registerTeacher(s1.app);
    const quiz = await makeQuiz(client);
    const { cls } = await makeClassWithStudents(client);
    await s1.close();

    const s2 = await startServer({ dataDir: s1.dataDir });
    const c2 = new Client(s2.app);
    expect((await c2.post('/api/auth/login', { email, password: 'correct horse 42' })).status).toBe(200);
    expect((await c2.get(`/api/quizzes/${quiz.id}`)).json.quiz.title).toBe('Science Quiz 1');
    expect((await c2.get(`/api/classes/${cls.id}`)).json.students).toHaveLength(3);
    expect((await c2.get('/api/settings/export')).json.students).toHaveLength(3);

    expect((await c2.post('/api/settings/delete-account', { password: 'wrong', confirm: 'DELETE' })).status).toBe(400);
    expect((await c2.post('/api/settings/delete-account', { password: 'correct horse 42', confirm: 'DELETE' })).status).toBe(200);
    for (const t of ['users', 'students', 'quizzes', 'classes', 'questions', 'enrollments']) {
      expect((s2.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, t).toBe(0);
    }
    await s2.close();
    fs.rmSync(s1.dataDir, { recursive: true, force: true });
  });
});
