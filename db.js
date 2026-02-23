// ═══════════════════════════════════════════════════════════
// FuelOS — Database layer using @libsql/client
// Pure JS SQLite — no native compilation, works on Node 25+
// ═══════════════════════════════════════════════════════════
import { createClient } from '@libsql/client';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// DB_PATH: file on Render disk (/var/data/fuelos.db) or local
const DB_FILE = process.env.DB_PATH || join(__dirname, 'fuelos.db');

// Ensure directory exists
const dir = join(DB_FILE, '..');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const client = createClient({ url: `file:${DB_FILE}` });

export async function initDb() {
  const schemaPath = join(__dirname, '../database/schema.sql');
  if (existsSync(schemaPath)) {
    const sql = readFileSync(schemaPath, 'utf8');
    // Split on semicolons and run each statement
    const stmts = sql.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of stmts) {
      await client.execute(stmt).catch(() => {}); // ignore "already exists"
    }
  }
  console.log('✓ Database ready:', DB_FILE);
  return client;
}

// ── Synchronous-style helpers (await internally)
export const db = {
  get: async (sql, params = []) => {
    const r = await client.execute({ sql, args: params });
    return r.rows[0] ? rowToObj(r.rows[0], r.columns) : null;
  },
  all: async (sql, params = []) => {
    const r = await client.execute({ sql, args: params });
    return r.rows.map(row => rowToObj(row, r.columns));
  },
  run: async (sql, params = []) => {
    const r = await client.execute({ sql, args: params });
    return { changes: r.rowsAffected, lastInsertRowid: r.lastInsertRowid };
  },
  tx: async (fn) => {
    await client.execute('BEGIN');
    try {
      await fn();
      await client.execute('COMMIT');
    } catch (e) {
      await client.execute('ROLLBACK');
      throw e;
    }
  },
  exec: async (sql) => {
    const stmts = sql.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of stmts) await client.execute(stmt);
  },
};

function rowToObj(row, columns) {
  const obj = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return obj;
}

export function getDb() { return client; }
