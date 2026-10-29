import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import type { DB } from '../db/index';
import type { Config } from '../config';

export function audit(db: DB, teacherId: number, entityType: string, entityId: number | null, action: string, summary: string, details?: unknown) {
  db.prepare('INSERT INTO audit_logs (teacher_id, entity_type, entity_id, action, summary, details_json) VALUES (?, ?, ?, ?, ?, ?)').run(
    teacherId,
    entityType,
    entityId,
    action,
    summary.slice(0, 300),
    details === undefined ? null : JSON.stringify(details),
  );
}

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
  readonly configured: boolean;
}

export function createMailer(config: Config, log: (msg: string) => void): Mailer {
  if (!config.SMTP_HOST) {
    return {
      configured: false,
      async send(to, subject, text) {
        // Development fallback: no SMTP configured, so the message goes to the server log only.
        log(`[mail not configured] To: ${to} | ${subject}\n${text}`);
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
  });
  return {
    configured: true,
    async send(to, subject, text) {
      await transport.sendMail({ from: config.SMTP_FROM, to, subject, text });
    },
  };
}

/** Private on-disk storage for scan images, partitioned per teacher. Files are never served statically. */
export class ScanStorage {
  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  save(teacherId: number, data: Buffer, ext: 'jpg' | 'png'): string {
    const dir = path.join(this.root, String(teacherId));
    fs.mkdirSync(dir, { recursive: true });
    const name = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(dir, name), data, { mode: 0o600 });
    return `${teacherId}/${name}`;
  }

  /** Resolves a stored relative path, refusing anything outside the storage root. */
  resolve(rel: string): string | null {
    const full = path.resolve(this.root, rel);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) return null;
    return full;
  }

  read(rel: string): Buffer | null {
    const full = this.resolve(rel);
    if (!full || !fs.existsSync(full)) return null;
    return fs.readFileSync(full);
  }

  remove(rel: string | null | undefined) {
    if (!rel) return;
    const full = this.resolve(rel);
    if (full && fs.existsSync(full)) fs.rmSync(full, { force: true });
  }

  removeTeacher(teacherId: number) {
    fs.rmSync(path.join(this.root, String(teacherId)), { recursive: true, force: true });
  }
}

/**
 * Retention: deletes original photos of confirmed scans older than each teacher's
 * retention window, discarded/failed scans after a day, and abandoned pending scans after 14 days.
 */
export function applyRetention(db: DB, storage: ScanStorage): number {
  const rows = db
    .prepare(
      `SELECT s.id, s.image_path, s.rectified_path FROM scans s JOIN users u ON u.id = s.teacher_id
       WHERE s.image_deleted_at IS NULL AND (s.image_path IS NOT NULL OR s.rectified_path IS NOT NULL) AND (
         (s.status = 'confirmed' AND julianday('now') - julianday(s.confirmed_at) >= u.image_retention_days)
         OR (s.status IN ('discarded', 'failed') AND julianday('now') - julianday(s.created_at) >= 1)
         OR (s.status = 'pending' AND julianday('now') - julianday(s.created_at) >= 14))`,
    )
    .all() as { id: number; image_path: string | null; rectified_path: string | null }[];
  const mark = db.prepare(`UPDATE scans SET image_path = NULL, rectified_path = NULL, image_deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`);
  for (const r of rows) {
    storage.remove(r.image_path);
    storage.remove(r.rectified_path);
    mark.run(r.id);
  }
  db.prepare(`DELETE FROM auth_sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run();
  db.prepare(`DELETE FROM password_resets WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', '-1 day')`).run();
  return rows.length;
}
