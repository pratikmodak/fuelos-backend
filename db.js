// ═══════════════════════════════════════════════════════════
// FuelOS — SQLite database layer (better-sqlite3)
// ═══════════════════════════════════════════════════════════
import Database       from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath }  from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_FILE   = process.env.DB_PATH || join(__dirname, 'fuelos.db');

let _db = null;

export function getDb() {
  if (!_db) {
    // Ensure directory exists (for Render Disk mounts at /var/data)
    const dir = join(DB_FILE, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    _db = new Database(DB_FILE);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

export function initDb() {
  const db  = getDb();
  const schemaPath = join(__dirname, '../database/schema.sql');
  if (existsSync(schemaPath)) {
    const sql = readFileSync(schemaPath, 'utf8');
    db.exec(sql);
  }
  console.log('✓ Database ready:', DB_FILE);
  return db;
}

// ── Helpers — params as spread array (better-sqlite3 style)
export const db = {
  get:  (sql, params = []) => getDb().prepare(sql).get(...params),
  all:  (sql, params = []) => getDb().prepare(sql).all(...params),
  run:  (sql, params = []) => getDb().prepare(sql).run(...params),
  tx:   (fn)               => getDb().transaction(fn)(),
  exec: (sql)              => getDb().exec(sql),
};
