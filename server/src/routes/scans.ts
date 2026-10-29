import type { FastifyInstance } from 'fastify';
import sharp, { type Metadata } from 'sharp';
import { z } from 'zod';
import type { Ctx } from '../app';
import { AppError, conflict, idParam, notFound, parse, requireUser } from '../http';
import { audit } from '../services/support';
import { sha256 } from '../auth/password';
import { loadQuestions, saveSubmission, assertGradable, type QuizRow } from '../services/grading';
import { normalizeStudentNumber } from '../services/students';
import { scanAnswerSheet } from '../scanner/scan';
import type { ScanResult, ScanSuccess } from '../../../shared/scan-types';
import { getOwnedSession, type SessionRow } from './sessions';
import { getOwnedQuiz } from './quizzes';

interface ScanRow {
  id: number;
  teacher_id: number;
  session_id: number;
  status: 'pending' | 'confirmed' | 'discarded' | 'failed';
  image_sha256: string;
  image_path: string | null;
  rectified_path: string | null;
  error_code: string | null;
  detected_student_number: string | null;
  flagged_count: number;
  result_json: string | null;
  submission_id: number | null;
  created_at: string;
  confirmed_at: string | null;
  image_deleted_at: string | null;
}

const ACCEPTED = new Set(['jpeg', 'png', 'webp', 'heif', 'tiff']);

function getOwnedScan(ctx: Ctx, teacherId: number, id: number): ScanRow {
  const row = ctx.db.prepare('SELECT * FROM scans WHERE id = ? AND teacher_id = ?').get(id, teacherId) as ScanRow | undefined;
  if (!row) throw notFound('Scan');
  return row;
}

/** Builds the review payload: scanner reading + roster match + existing-result warning. */
function scanView(ctx: Ctx, scan: ScanRow, session: SessionRow, quiz: QuizRow) {
  const result = scan.result_json ? (JSON.parse(scan.result_json) as ScanResult) : null;
  const { db } = ctx;
  let matchedStudent: { id: number; firstName: string; lastName: string; studentNumber: string; enrolled: boolean } | null = null;
  if (scan.detected_student_number) {
    const s = db
      .prepare(
        `SELECT s.id, s.first_name, s.last_name, s.student_number,
           EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = s.id AND e.class_id = ?) AS enrolled
         FROM students s WHERE s.teacher_id = ? AND s.student_number = ? AND s.archived_at IS NULL`,
      )
      .get(session.class_id, scan.teacher_id, scan.detected_student_number) as
      | { id: number; first_name: string; last_name: string; student_number: string; enrolled: number }
      | undefined;
    if (s) matchedStudent = { id: s.id, firstName: s.first_name, lastName: s.last_name, studentNumber: s.student_number, enrolled: !!s.enrolled };
  }
  const existing = matchedStudent
    ? (db.prepare('SELECT id, percent FROM submissions WHERE session_id = ? AND student_id = ?').get(session.id, matchedStudent.id) as { id: number; percent: number } | undefined)
    : undefined;
  const questions = loadQuestions(db, quiz.id);
  return {
    scan: {
      id: scan.id,
      sessionId: scan.session_id,
      status: scan.status,
      createdAt: scan.created_at,
      confirmedAt: scan.confirmed_at,
      submissionId: scan.submission_id,
      hasRectifiedImage: !!scan.rectified_path,
      hasOriginalImage: !!scan.image_path,
    },
    result,
    matchedStudent,
    existingSubmission: existing ? { id: existing.id, percent: existing.percent } : null,
    key: questions.map((q) => ({ number: q.number, correctChoice: q.correct_choice, points: q.points, excluded: !!q.excluded })),
    quiz: { id: quiz.id, title: quiz.title, questionCount: quiz.question_count, choiceCount: quiz.choice_count },
  };
}

const confirmSchema = z.object({
  studentId: z.number().int().positive(),
  replaceExisting: z.boolean().default(false),
  /** Required when the sheet code could not be verified. */
  confirmSheetMatches: z.boolean().default(false),
  answers: z
    .array(
      z.object({
        number: z.number().int().min(1).max(100),
        status: z.enum(['answered', 'blank', 'multiple']),
        choice: z.number().int().min(0).max(4).nullable(),
        marked: z.array(z.number().int().min(0).max(4)).max(5).optional(),
        /** The teacher explicitly reviewed this flagged item. */
        reviewed: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(100),
});

export async function scanRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, storage } = ctx;

  app.post('/sessions/:id/scans', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const session = getOwnedSession(ctx, user.id, id);
    if (session.archived_at) throw new AppError(400, 'SESSION_ARCHIVED', 'This grading session is archived.');
    const quiz = getOwnedQuiz(ctx, user.id, session.quiz_id);
    assertGradable(quiz, loadQuestions(db, quiz.id));

    const file = await req.file();
    if (!file) throw new AppError(400, 'NO_FILE', 'Attach a photo of the answer sheet.');
    const input = await file.toBuffer();
    if (!input.length) throw new AppError(400, 'NO_FILE', 'The uploaded file is empty.');

    // Validate the content (not the client-supplied MIME type) and strip metadata such as GPS location.
    let meta: Metadata;
    try {
      meta = await sharp(input).metadata();
    } catch {
      throw new AppError(415, 'UNSUPPORTED_FILE', 'This file is not a supported image. Use JPEG, PNG or WebP.');
    }
    if (!meta.format || !ACCEPTED.has(meta.format)) throw new AppError(415, 'UNSUPPORTED_FILE', 'This file is not a supported image. Use JPEG, PNG or WebP.');
    if ((meta.width ?? 0) * (meta.height ?? 0) > 80_000_000) throw new AppError(413, 'IMAGE_TOO_LARGE', 'The image dimensions are too large.');

    const hash = sha256(input);
    const dup = db.prepare(`SELECT id, status FROM scans WHERE session_id = ? AND image_sha256 = ? AND status IN ('pending','confirmed')`).get(id, hash) as
      | { id: number; status: string }
      | undefined;
    if (dup) {
      throw conflict(dup.status === 'confirmed' ? 'This exact photo was already graded in this session.' : 'This photo is already waiting for review.', { scanId: dup.id, status: dup.status });
    }

    let stored: Buffer;
    try {
      stored = await sharp(input).rotate().resize({ width: 3000, height: 3000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
    } catch {
      throw new AppError(415, 'UNSUPPORTED_FILE', 'The image could not be decoded. Try exporting it as JPEG.');
    }

    const { result, rectifiedJpeg } = await scanAnswerSheet(stored, {
      expected: { questionCount: quiz.question_count, choiceCount: quiz.choice_count, quizCode: quiz.sheet_code },
      rectifiedImage: true,
    });

    let status: ScanRow['status'] = 'pending';
    let errorCode: string | null = null;
    let finalResult: ScanResult = result;
    if (!result.ok) {
      status = 'failed';
      errorCode = result.error.code;
    } else if (result.codeVerified && (result.sheet.quizCode !== quiz.sheet_code || result.sheet.questionCount !== quiz.question_count || result.sheet.choiceCount !== quiz.choice_count)) {
      // The sheet belongs to a different quiz (or an older version of this one).
      const other = db.prepare('SELECT id, title FROM quizzes WHERE sheet_code = ? AND teacher_id = ?').get(result.sheet.quizCode, user.id) as { id: number; title: string } | undefined;
      status = 'failed';
      errorCode = 'WRONG_QUIZ';
      finalResult = {
        ok: false,
        warnings: result.warnings,
        error: {
          code: 'WRONG_QUIZ',
          message: other ? `This answer sheet belongs to the quiz "${other.title}", not "${quiz.title}".` : `This answer sheet does not belong to "${quiz.title}".`,
          hint: other
            ? 'Scan it in a grading session for that quiz.'
            : 'It may have been printed before the quiz layout changed, or for another quiz. Print fresh sheets for this quiz.',
        },
      };
    }

    const imagePath = storage.save(user.id, stored, 'jpg');
    const rectifiedPath = rectifiedJpeg && status === 'pending' ? storage.save(user.id, rectifiedJpeg, 'jpg') : null;
    let detected: string | null = null;
    if (finalResult.ok && finalResult.studentId.value) detected = normalizeStudentNumber(finalResult.studentId.value);
    const info = db
      .prepare(
        `INSERT INTO scans (teacher_id, session_id, status, image_sha256, image_path, rectified_path, error_code, detected_student_number, flagged_count, result_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(user.id, id, status, hash, imagePath, rectifiedPath, errorCode, detected, finalResult.ok ? finalResult.flaggedCount : 0, JSON.stringify(finalResult));
    const scan = getOwnedScan(ctx, user.id, Number(info.lastInsertRowid));
    return reply.status(finalResult.ok ? 201 : 422).send(scanView(ctx, scan, session, quiz));
  });

  app.get('/scans/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const scan = getOwnedScan(ctx, user.id, id);
    const session = getOwnedSession(ctx, user.id, scan.session_id);
    return scanView(ctx, scan, session, getOwnedQuiz(ctx, user.id, session.quiz_id));
  });

  app.get('/scans/:id/image', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { kind } = parse(z.object({ kind: z.enum(['rectified', 'original']).default('rectified') }), req.query);
    const scan = getOwnedScan(ctx, user.id, id);
    const rel = kind === 'rectified' ? scan.rectified_path : scan.image_path;
    const data = rel ? storage.read(rel) : null;
    if (!data) throw notFound('Image (it may have been removed by the retention policy)');
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=600').send(data);
  });

  app.post('/scans/:id/discard', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const scan = getOwnedScan(ctx, user.id, id);
    if (scan.status === 'confirmed') throw conflict('This scan was already confirmed. Delete the result instead.');
    db.prepare(`UPDATE scans SET status = 'discarded' WHERE id = ?`).run(id);
    storage.remove(scan.image_path);
    storage.remove(scan.rectified_path);
    db.prepare(`UPDATE scans SET image_path = NULL, rectified_path = NULL, image_deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(id);
    return { ok: true };
  });

  app.post('/scans/:id/confirm', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const scan = getOwnedScan(ctx, user.id, id);
    if (scan.status === 'confirmed') throw conflict('This scan has already been confirmed.', { submissionId: scan.submission_id });
    if (scan.status !== 'pending') throw new AppError(400, 'SCAN_NOT_PENDING', 'Only scans waiting for review can be confirmed.');
    const result = JSON.parse(scan.result_json ?? 'null') as ScanSuccess | null;
    if (!result?.ok) throw new AppError(400, 'SCAN_FAILED', 'This scan could not be read.');
    const session = getOwnedSession(ctx, user.id, scan.session_id);
    const quiz = getOwnedQuiz(ctx, user.id, session.quiz_id);
    const body = parse(confirmSchema, req.body);

    if (!result.codeVerified && !body.confirmSheetMatches) {
      throw new AppError(400, 'CONFIRM_SHEET', 'The sheet code could not be verified. Confirm that this sheet belongs to the selected quiz.');
    }
    // Never finalise uncertain readings silently: every flagged item must be explicitly reviewed.
    const flagged = result.answers.filter((a) => a.status === 'ambiguous' || a.status === 'multiple').map((a) => a.question);
    const reviewed = new Set(body.answers.filter((a) => a.reviewed).map((a) => a.number));
    const unreviewed = flagged.filter((q) => !reviewed.has(q));
    if (unreviewed.length) {
      throw new AppError(400, 'UNREVIEWED_FLAGS', `Review the flagged question(s) before saving: ${unreviewed.join(', ')}.`, { questions: unreviewed });
    }
    const student = db.prepare('SELECT id FROM students WHERE id = ? AND teacher_id = ?').get(body.studentId, user.id);
    if (!student) throw notFound('Student');
    const enrolled = db.prepare('SELECT 1 FROM enrollments WHERE class_id = ? AND student_id = ?').get(session.class_id, body.studentId);
    if (!enrolled) throw new AppError(400, 'NOT_ENROLLED', 'This student is not enrolled in the session’s class. Enroll them first.');

    const scannerByQ = new Map(result.answers.map((a) => [a.question, a]));
    const responses = body.answers.map((a) => {
      const s = scannerByQ.get(a.number);
      const scannerStatus = s?.status ?? null;
      const scannerChoice = s?.status === 'ok' ? s.choice : null;
      const scannerResponse = s?.status === 'ok' ? 'answered' : s?.status === 'blank' ? 'blank' : s?.status === 'multiple' ? 'multiple' : null;
      const override = scannerStatus === 'ambiguous' ? true : scannerResponse !== a.status || (a.status === 'answered' && scannerChoice !== a.choice);
      return {
        number: a.number,
        status: a.status,
        choice: a.status === 'answered' ? a.choice : null,
        marked: a.status === 'multiple' ? (a.marked?.length ? a.marked : (s?.marked ?? [])) : undefined,
        scannerStatus,
        scannerConfidence: s?.confidence ?? null,
        teacherOverride: override,
      };
    });

    const saved = db.transaction(() => {
      const res = saveSubmission(db, quiz, loadQuestions(db, quiz.id), {
        teacherId: user.id,
        sessionId: session.id,
        studentId: body.studentId,
        source: 'scan',
        responses,
        replaceExisting: body.replaceExisting,
      });
      db.prepare(`UPDATE scans SET status = 'confirmed', confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), submission_id = ? WHERE id = ?`).run(res.submissionId, id);
      if (body.studentId && scan.detected_student_number) {
        const sn = (db.prepare('SELECT student_number FROM students WHERE id = ?').get(body.studentId) as { student_number: string }).student_number;
        if (sn !== scan.detected_student_number) {
          audit(db, user.id, 'scan', id, 'student_override', `Assigned scan to student #${sn} (sheet ID read as ${scan.detected_student_number})`);
        }
      }
      return res;
    })();

    // Retention 0 days: remove photos as soon as the result is confirmed.
    if (user.imageRetentionDays === 0) {
      storage.remove(scan.image_path);
      storage.remove(scan.rectified_path);
      db.prepare(`UPDATE scans SET image_path = NULL, rectified_path = NULL, image_deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(id);
    }
    return { submissionId: saved.submissionId, grade: saved.grade, replaced: saved.replaced };
  });
}
