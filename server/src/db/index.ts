import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

const here = path.dirname(fileURLToPath(import.meta.url));

/** Locates the SQL migrations both in development (tsx) and in the bundled build. */
function migrationsDir(): string {
  const candidates = [path.resolve(here, '../../migrations'), path.resolve(here, '../../server/migrations'), path.resolve(process.cwd(), 'server/migrations')];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Could not locate server/migrations');
  return found;
}

export function openDatabase(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}

/** Applies pending migrations in filename order, each in its own transaction. */
export function migrate(db: DB, log: (msg: string) => void = () => {}): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  const applied = new Set((db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name));
  const dir = migrationsDir();
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(f);
    })();
    log(`applied migration ${f}`);
    ran.push(f);
  }
  return ran;
}

export const nowIso = () => new Date().toISOString();
