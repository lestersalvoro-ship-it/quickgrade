import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found.`);
export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'CONFLICT', message, details);

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new AppError(400, 'VALIDATION_ERROR', issues[0] ? `${issues[0].path ? issues[0].path + ': ' : ''}${issues[0].message}` : 'Invalid input.', issues);
  }
  return r.data;
}

export interface AuthUser {
  id: number;
  email: string;
  fullName: string;
  schoolName: string | null;
  defaultPassPercent: number;
  imageRetentionDays: number;
  sessionId: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in.');
  return req.user;
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Common optional text field: trims, converts empty strings to null. */
export const optText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => {
      const t = v?.trim();
      return t ? t : null;
    });

export const reqText = (max: number) => z.string().trim().min(1, 'Required').max(max);

/** Neutralises spreadsheet formula injection in exported CSV cells. */
export function csvSafe(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function sendCsv(reply: FastifyReply, filename: string, csv: string) {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${filename.replace(/[^\w.-]+/g, '_')}"`)
    .send('﻿' + csv);
}

export function sendPdf(reply: FastifyReply, filename: string, pdf: Buffer, inline = false) {
  return reply
    .header('content-type', 'application/pdf')
    .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/[^\w.-]+/g, '_')}"`)
    .send(pdf);
}
