// ═══════════════════════════════════════════════════════════
// FuelOS — Database layer (@libsql/client, pure JS)
// Schema embedded directly — no external file needed
// ═══════════════════════════════════════════════════════════
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// ── Database connection
// Priority: TURSO_URL (hosted, persistent) > DB_PATH (local file) > /tmp (ephemeral)
//
// FREE PERSISTENT DB: Sign up at turso.tech, create a DB, set these env vars on Render:
//   TURSO_URL      = libsql://your-db-name.turso.io
//   TURSO_TOKEN    = your-auth-token
//
// WITHOUT Turso: data is lost every time Render restarts (free tier = every ~15min idle)

const TURSO_URL   = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
const DB_FILE     = process.env.DB_PATH || '/tmp/fuelos.db';

let client;
if (TURSO_URL) {
  // Hosted Turso DB — data persists forever
  client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
  console.log('[DB] Using Turso hosted DB:', TURSO_URL.split('.')[0]);
} else {
  // Local file DB — /tmp is wiped on Render restart
  client = createClient({ url: `file:${DB_FILE}` });
  console.log('[DB] ⚠ Using local file DB (data lost on restart):', DB_FILE);
  console.log('[DB] → Set TURSO_URL + TURSO_TOKEN env vars for persistent storage');
}

// ── Full schema embedded (no external file dependency)
const SCHEMA = `
CREATE TABLE IF NOT EXISTS owners (
  id            TEXT PRIMARY KEY,          -- e.g. O1, O2
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  phone         TEXT,
  city          TEXT,
  state         TEXT,
  address       TEXT,
  gst           TEXT,
  avatar        TEXT,                      -- initials or emoji
  plan          TEXT NOT NULL DEFAULT 'Starter', -- Starter | Pro | Enterprise
  billing       TEXT NOT NULL DEFAULT 'monthly', -- monthly | yearly
  status        TEXT NOT NULL DEFAULT 'Active',  -- Active | Inactive | Suspended | Pending
  amount_paid   REAL DEFAULT 0,
  start_date    TEXT,                      -- ISO date YYYY-MM-DD
  end_date      TEXT,                      -- ISO date YYYY-MM-DD
  days_used     INTEGER DEFAULT 0,
  whatsapp      INTEGER DEFAULT 0,         -- boolean 0/1
  whatsapp_num  TEXT,
  razorpay_cid  TEXT,                      -- Razorpay customer ID
  created_at    TEXT DEFAULT (date('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pumps (
  id          TEXT NOT NULL,
  owner_id    TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  short_name  TEXT NOT NULL,
  city        TEXT,
  state       TEXT,
  address     TEXT,
  gst         TEXT,
  status      TEXT DEFAULT 'Active',       -- Active | Inactive | Maintenance
  created_at  TEXT DEFAULT (date('now')),
  PRIMARY KEY (id, owner_id)
);
CREATE TABLE IF NOT EXISTS nozzles (
  id           TEXT NOT NULL,
  pump_id      TEXT NOT NULL,
  owner_id     TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  fuel         TEXT NOT NULL,              -- Petrol | Diesel | CNG
  open_reading REAL DEFAULT 0,            -- current shift opening meter reading
  close_reading REAL,                     -- last close reading
  operator     TEXT,                      -- assigned operator name
  status       TEXT DEFAULT 'Active',     -- Active | Idle | Maintenance
  PRIMARY KEY (id, pump_id)
);
CREATE TABLE IF NOT EXISTS managers (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  pump_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  email        TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  phone        TEXT,
  shift        TEXT DEFAULT 'Morning',
  salary       REAL DEFAULT 0,
  status       TEXT DEFAULT 'Active',
  created_at   TEXT DEFAULT (date('now'))
);
CREATE TABLE IF NOT EXISTS operators (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  pump_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  email        TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  phone        TEXT,
  shift        TEXT DEFAULT 'Morning',
  nozzles      TEXT DEFAULT '[]',         -- JSON array of nozzle IDs
  salary       REAL DEFAULT 0,
  present      INTEGER DEFAULT 1,         -- boolean
  status       TEXT DEFAULT 'Active',
  created_at   TEXT DEFAULT (date('now'))
);
CREATE TABLE IF NOT EXISTS shift_reports (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES owners(id),
  pump_id       TEXT NOT NULL,
  date          TEXT NOT NULL,            -- YYYY-MM-DD
  shift         TEXT NOT NULL,            -- Morning | Afternoon | Night
  shift_index   INTEGER NOT NULL,         -- 0 | 1 | 2
  manager       TEXT,
  status        TEXT DEFAULT 'Submitted',
  total_sales   REAL DEFAULT 0,
  cash          REAL DEFAULT 0,
  card          REAL DEFAULT 0,
  upi           REAL DEFAULT 0,
  credit_out    REAL DEFAULT 0,
  variance      REAL DEFAULT 0,
  denom_total   REAL DEFAULT 0,
  nozzle_count  INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(pump_id, date, shift)
);
CREATE TABLE IF NOT EXISTS nozzle_readings (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL REFERENCES owners(id),
  pump_id        TEXT NOT NULL,
  nozzle_id      TEXT NOT NULL,
  fuel           TEXT NOT NULL,
  date           TEXT NOT NULL,           -- YYYY-MM-DD
  shift          TEXT NOT NULL,           -- Morning | Afternoon | Night
  shift_index    INTEGER NOT NULL,
  open_reading   REAL NOT NULL,
  close_reading  REAL NOT NULL,
  test_vol       REAL DEFAULT 0,          -- machine test qty deducted
  net_vol        REAL DEFAULT 0,          -- close - open - test_vol
  sale_vol       REAL DEFAULT 0,          -- same as net_vol for billing
  revenue        REAL DEFAULT 0,
  rate           REAL NOT NULL,           -- price per litre at time of sale
  operator       TEXT,
  status         TEXT DEFAULT 'Submitted',
  created_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_nozzle_readings_pump_date ON nozzle_readings(pump_id, date);
CREATE INDEX IF NOT EXISTS idx_nozzle_readings_shift ON nozzle_readings(pump_id, date, shift);
CREATE TABLE IF NOT EXISTS sales (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES owners(id),
  pump_id     TEXT NOT NULL,
  date        TEXT NOT NULL,              -- YYYY-MM-DD
  petrol      REAL DEFAULT 0,             -- ₹ revenue
  diesel      REAL DEFAULT 0,
  cng         REAL DEFAULT 0,
  cash        REAL DEFAULT 0,
  card        REAL DEFAULT 0,
  upi         REAL DEFAULT 0,
  credit_out  REAL DEFAULT 0,
  UNIQUE(pump_id, date)
);
CREATE INDEX IF NOT EXISTS idx_sales_owner_date ON sales(owner_id, date);
CREATE INDEX IF NOT EXISTS idx_sales_pump_date  ON sales(pump_id, date);
CREATE TABLE IF NOT EXISTS tanks (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES owners(id),
  pump_id     TEXT NOT NULL,
  fuel        TEXT NOT NULL,
  capacity    REAL NOT NULL,              -- litres
  stock       REAL NOT NULL DEFAULT 0,
  dip         REAL DEFAULT 0,             -- dip stick reading
  updated     TEXT DEFAULT (date('now')),
  alert_at    REAL DEFAULT 1000           -- low stock threshold
);
CREATE TABLE IF NOT EXISTS machine_tests (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES owners(id),
  pump_id         TEXT NOT NULL,
  nozzle_id       TEXT NOT NULL,
  fuel            TEXT NOT NULL,
  date            TEXT NOT NULL,
  time            TEXT,
  shift           TEXT,
  operator        TEXT,
  qty             REAL DEFAULT 1.0,       -- test quantity (litres)
  meter_before    REAL,
  meter_after     REAL,
  jar_reading     REAL,
  variance        REAL,                   -- ml
  result          TEXT,                   -- Pass | Warning | Fail | Pending
  returned_to_tank INTEGER DEFAULT 1,
  notes           TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS transactions (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES owners(id),
  plan            TEXT NOT NULL,
  billing         TEXT NOT NULL,          -- monthly | yearly
  amount          REAL NOT NULL,          -- total incl GST
  base            REAL,                   -- base amount before GST
  gst             REAL,                   -- 18% GST
  credit          REAL DEFAULT 0,         -- pro-rata upgrade credit
  date            TEXT NOT NULL,
  method          TEXT,                   -- UPI | Card | NetBanking | Wallet
  status          TEXT DEFAULT 'Pending', -- Pending | Success | Failed | Refunded
  razorpay_id     TEXT,                   -- Razorpay payment/order ID
  razorpay_sig    TEXT,                   -- payment signature for verification
  plan_activated  INTEGER DEFAULT 0,      -- boolean: was plan switched?
  fail_reason     TEXT,
  webhook_event   TEXT,                   -- payment.captured | payment.failed etc
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transactions_owner ON transactions(owner_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE TABLE IF NOT EXISTS credit_customers (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES owners(id),
  pump_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  phone       TEXT,
  credit_limit REAL DEFAULT 0,
  outstanding REAL DEFAULT 0,
  last_txn    TEXT,
  status      TEXT DEFAULT 'Active'       -- Active | Overdue | Suspended
);
CREATE TABLE IF NOT EXISTS wa_log (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES owners(id),
  type        TEXT NOT NULL,              -- payment | shift | alert | test
  message     TEXT NOT NULL,
  phone       TEXT,
  date        TEXT DEFAULT (date('now')),
  status      TEXT DEFAULT 'Pending',     -- Pending | Delivered | Failed
  provider    TEXT,                       -- meta | twilio | wati etc
  provider_id TEXT,                       -- external message ID
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wa_log_owner ON wa_log(owner_id);
CREATE TABLE IF NOT EXISTS coupons (
  id        TEXT PRIMARY KEY,
  code      TEXT UNIQUE NOT NULL,
  discount  REAL NOT NULL,
  type      TEXT DEFAULT 'flat',          -- flat | percent
  uses      INTEGER DEFAULT 0,
  max_uses  INTEGER DEFAULT 100,
  status    TEXT DEFAULT 'Active'
);
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  user_email  TEXT NOT NULL,
  role        TEXT NOT NULL,              -- Admin | Owner | Manager | Operator
  action      TEXT NOT NULL,
  ip          TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS integration_config (
  key         TEXT PRIMARY KEY,           -- razorpay_key_id, wa_api_key, etc
  value       TEXT,                       -- encrypted value
  updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notifications (
  id        TEXT PRIMARY KEY,
  owner_id  TEXT NOT NULL REFERENCES owners(id),
  pump_id   TEXT,
  type      TEXT,                         -- alert | warn | info | success
  message   TEXT NOT NULL,
  time_ago  TEXT,
  is_read   INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO owners VALUES
  ('O1','Rajesh Sharma','rajesh@sharma.com','owner123',
   '9876543210','Pune','Maharashtra','Koregaon Park, Pune',
   '27AAACR5055K1Z5','RS','Pro','monthly','Active',
   2499,'2025-02-01','2025-03-01',21,1,'9876543210',
   'cust_razorpay001',date('now'),datetime('now')),
  ('O2','Anil Gupta','anil@gupta.com','owner123',
   '9876543211','Mumbai','Maharashtra','Andheri West, Mumbai',
   '27AAACR5055K2Z6','AG','Starter','yearly','Active',
   799,'2025-01-05','2026-01-05',47,0,NULL,
   'cust_razorpay002',date('now'),datetime('now')),
  ('O3','Meena Krishnan','meena@krishnan.com','owner123',
   '9876543212','Mumbai','Maharashtra','Bandra West, Mumbai',
   '27AAACR5055K3Z7','MK','Enterprise','monthly','Active',
   5999,'2025-02-01','2025-03-01',21,1,'9876543212',
   'cust_razorpay003',date('now'),datetime('now'));
INSERT OR IGNORE INTO coupons VALUES
  ('CPN1','FIRST50',50,'flat',12,100,'Active'),
  ('CPN2','SAVE10',10,'percent',34,200,'Active'),
  ('CPN3','ANNUAL15',15,'percent',8,50,'Active');
`;

export async function initDb() {
  // Run each CREATE TABLE statement individually
  const statements = SCHEMA
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 10);  // skip empty/whitespace

  let created = 0;
  for (const stmt of statements) {
    try {
      await client.execute(stmt);
      if (stmt.includes('CREATE TABLE')) created++;
    } catch (e) {
      // Ignore "already exists" errors, log others
      if (!e.message?.includes('already exists') && !e.message?.includes('duplicate')) {
        console.warn('[DB] Statement warning:', e.message?.slice(0, 80));
      }
    }
  }
  console.log(`✓ DB ready — ${created} tables initialized`);

  // ── Column migrations (safe to run repeatedly)
  const columnMigrations = [
    "ALTER TABLE shift_reports ADD COLUMN confirmed_by TEXT",
    "ALTER TABLE shift_reports ADD COLUMN confirmed_at TEXT",
  ];
  for (const m of columnMigrations) {
    try { await client.execute(m); } catch(e) { /* column already exists — OK */ }
  }

  // Seed demo data if owners table is empty
  const check = await client.execute('SELECT COUNT(*) as c FROM owners');
  const count = check.rows[0][0];
  if (Number(count) === 0) {
    await seedDemoData();
  }

  return client;
}

async function seedDemoData() {
  console.log('[DB] Seeding demo data...');
  const seeds = [
    `INSERT OR IGNORE INTO owners (id,name,email,password_hash,phone,city,state,plan,billing,status,amount_paid,start_date,end_date,days_used,whatsapp,avatar)
     VALUES ('O1','Rajesh Sharma','rajesh@sharma.com','owner123','9876543210','Pune','Maharashtra','Pro','monthly','Active',2499,'2025-02-01','2025-03-01',21,1,'RS')`,
    `INSERT OR IGNORE INTO owners (id,name,email,password_hash,phone,city,state,plan,billing,status,amount_paid,start_date,end_date,days_used,whatsapp,avatar)
     VALUES ('O2','Anil Gupta','anil@gupta.com','owner123','9876543211','Mumbai','Maharashtra','Starter','yearly','Active',7990,'2025-01-05','2026-01-05',47,0,'AG')`,
    `INSERT OR IGNORE INTO owners (id,name,email,password_hash,phone,city,state,plan,billing,status,amount_paid,start_date,end_date,days_used,whatsapp,avatar)
     VALUES ('O3','Meena Krishnan','meena@krishnan.com','owner123','9876543212','Mumbai','Maharashtra','Enterprise','monthly','Active',5999,'2025-02-01','2025-03-01',21,1,'MK')`,
    `INSERT OR IGNORE INTO pumps (id,owner_id,name,short_name,city,state,status)
     VALUES ('P1','O1','Sharma Petrol Pump – Koregaon Park','Koregaon','Pune','Maharashtra','Active')`,
    `INSERT OR IGNORE INTO pumps (id,owner_id,name,short_name,city,state,status)
     VALUES ('P2','O1','Sharma Fuel Station – Kothrud','Kothrud','Pune','Maharashtra','Active')`,
    `INSERT OR IGNORE INTO pumps (id,owner_id,name,short_name,city,state,status)
     VALUES ('P4','O2','Gupta Fuel Station','Gupta Fuel','Mumbai','Maharashtra','Active')`,
    `INSERT OR IGNORE INTO pumps (id,owner_id,name,short_name,city,state,status)
     VALUES ('P5','O3','Krishnan Petro – Bandra','Bandra','Mumbai','Maharashtra','Active')`,
    `INSERT OR IGNORE INTO managers (id,owner_id,pump_id,name,email,password_hash,shift,status)
     VALUES ('M1','O1','P1','Vikram Sharma','vikram@sharma.com','mgr123','Morning','Active')`,
    `INSERT OR IGNORE INTO managers (id,owner_id,pump_id,name,email,password_hash,shift,status)
     VALUES ('M2','O2','P4','Kavitha Gupta','kavitha@gupta.com','mgr123','Morning','Active')`,
    `INSERT OR IGNORE INTO operators (id,owner_id,pump_id,name,email,password_hash,shift,status)
     VALUES ('OP1','O1','P1','Amit Kumar','amit@sharma.com','op123','Morning','Active')`,
    `INSERT OR IGNORE INTO coupons (id,code,discount,type,uses,max_uses,status)
     VALUES ('CPN1','FIRST50',50,'flat',0,100,'Active')`,
    `INSERT OR IGNORE INTO coupons (id,code,discount,type,uses,max_uses,status)
     VALUES ('CPN2','SAVE10',10,'percent',0,200,'Active')`,
  ];
  for (const sql of seeds) {
    await client.execute(sql).catch(e => console.warn('[Seed]', e.message?.slice(0,60)));
  }
  console.log('[DB] Demo data seeded');
}

// ── Query helpers
// @libsql/client rows are already plain objects with named keys
function toObj(row) {
  if (!row) return null;
  // Convert any special types to plain JS values
  const obj = {};
  for (const [k, v] of Object.entries(row)) {
    obj[k] = v ?? null;
  }
  return obj;
}

export const db = {
  get: async (sql, params = []) => {
    const r = await client.execute({ sql, args: params });
    return r.rows[0] ? toObj(r.rows[0]) : null;
  },
  all: async (sql, params = []) => {
    const r = await client.execute({ sql, args: params });
    return r.rows.map(row => toObj(row));
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
};

export function getDb() { return client; }
