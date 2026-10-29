import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';

/** Prepared statement. Rows are cast to typed interfaces at each call site; integers are JS numbers. */
export interface Statement {
  run(...params: any[]): { changes: number; lastInsertRowid: number };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

/**
 * Thin wrapper around Node's built-in SQLite (node:sqlite, Node ≥ 22.13), so the app
 * needs no native database module and installs on any platform without compilers.
 * It exposes the small API the code uses: prepare/exec plus nestable transactions.
 */
export class DB {
  private depth = 0;
  private savepoint = 0;

  constructor(readonly raw: DatabaseSync) {}

  prepare(sql: string): Statement {
    return this.raw.prepare(sql) as unknown as Statement;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  pragma(setting: string): void {
    this.raw.exec(`PRAGMA ${setting}`);
  }

  /** Wraps fn in a transaction; nested calls become savepoints. Returns a callable, like better-sqlite3. */
  transaction<T>(fn: () => T): () => T {
    return () => {
      const outer = this.depth === 0;
      const sp = `qg_sp_${++this.savepoint}`;
      this.raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const result = fn();
        this.depth--;
        this.raw.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
        return result;
      } catch (err) {
        this.depth--;
        this.raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw err;
      }
    };
  }

  /** Consistent online copy of the database to another file. */
  async backup(destination: string): Promise<void> {
    await sqliteBackup(this.raw, destination);
  }

  close(): void {
    this.raw.close();
  }
}

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
  const db = new DB(new DatabaseSync(file));
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
