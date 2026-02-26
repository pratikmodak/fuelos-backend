-- ═══════════════════════════════════════════════
-- FuelOS v3 — PostgreSQL Schema
-- Run this on your Render PostgreSQL database
-- ═══════════════════════════════════════════════

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────
-- COMPANY PORTAL USERS (SuperAdmin, Admin, Monitor, Caller)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_users (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email       TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('superadmin','admin','monitor','caller')),
  password    TEXT NOT NULL,
  two_fa_secret TEXT,
  two_fa_enabled BOOLEAN DEFAULT FALSE,
  backup_codes TEXT[], -- hashed backup codes
  otp_code    TEXT,
  otp_expires TIMESTAMPTZ,
  last_login  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- OWNERS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS owners (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email        TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  phone        TEXT,
  password     TEXT NOT NULL,
  plan         TEXT NOT NULL DEFAULT 'Starter' CHECK (plan IN ('Starter','Pro','Enterprise')),
  billing      TEXT NOT NULL DEFAULT 'monthly' CHECK (billing IN ('monthly','yearly')),
  status       TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Suspended','Trial','Expired')),
  business_name TEXT,
  gst          TEXT,
  pan          TEXT,
  address      TEXT,
  city         TEXT,
  state        TEXT,
  whatsapp     BOOLEAN DEFAULT FALSE,
  whatsapp_num TEXT,
  shift_config JSONB DEFAULT '[]',
  start_date   DATE DEFAULT CURRENT_DATE,
  end_date     DATE DEFAULT (CURRENT_DATE + INTERVAL '30 days'),
  days_used    INTEGER DEFAULT 0,
  amount_paid  NUMERIC(10,2) DEFAULT 0,
  leaderboard_public BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- PUMPS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pumps (
  id           TEXT PRIMARY KEY, -- P<uuid> format from frontend
  owner_id     UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  short_name   TEXT,
  city         TEXT,
  state        TEXT,
  address      TEXT,
  gst          TEXT,
  status       TEXT DEFAULT 'Active',
  color        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- NOZZLES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nozzles (
  id           TEXT PRIMARY KEY,
  pump_id      TEXT NOT NULL REFERENCES pumps(id) ON DELETE CASCADE,
  owner_id     UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  fuel         TEXT NOT NULL CHECK (fuel IN ('Petrol','Diesel','CNG')),
  status       TEXT DEFAULT 'Active',
  operator     TEXT,
  open         NUMERIC(12,2) DEFAULT 0,
  close        NUMERIC(12,2) DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- MANAGERS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS managers (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id     UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  pump_id      TEXT REFERENCES pumps(id) ON DELETE SET NULL,
  email        TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  phone        TEXT,
  password     TEXT NOT NULL,
  shift        TEXT DEFAULT 'Morning',
  salary       NUMERIC(10,2) DEFAULT 0,
  status       TEXT DEFAULT 'Active',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- OPERATORS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS operators (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id     UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  pump_id      TEXT REFERENCES pumps(id) ON DELETE SET NULL,
  email        TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  phone        TEXT,
  password     TEXT NOT NULL,
  shift        TEXT DEFAULT 'Morning',
  nozzles      TEXT, -- comma-separated nozzle IDs
  salary       NUMERIC(10,2) DEFAULT 0,
  status       TEXT DEFAULT 'Active',
  points       INTEGER DEFAULT 0,
  streak       INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- SHIFT REPORTS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shift_reports (
  id           TEXT PRIMARY KEY,
  owner_id     UUID REFERENCES owners(id) ON DELETE CASCADE,
  pump_id      TEXT REFERENCES pumps(id) ON DELETE SET NULL,
  operator_id  UUID REFERENCES operators(id) ON DELETE SET NULL,
  operator     TEXT,
  shift        TEXT,
  date         DATE NOT NULL,
  nozzle_readings JSONB DEFAULT '[]',
  cash         NUMERIC(10,2) DEFAULT 0,
  upi          NUMERIC(10,2) DEFAULT 0,
  card         NUMERIC(10,2) DEFAULT 0,
  credit       NUMERIC(10,2) DEFAULT 0,
  total_revenue NUMERIC(10,2) DEFAULT 0,
  petrol_vol   NUMERIC(10,2) DEFAULT 0,
  diesel_vol   NUMERIC(10,2) DEFAULT 0,
  cng_vol      NUMERIC(10,2) DEFAULT 0,
  status       TEXT DEFAULT 'Submitted',
  note         TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- NOZZLE READINGS (individual entries)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nozzle_readings (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shift_id     TEXT REFERENCES shift_reports(id) ON DELETE CASCADE,
  pump_id      TEXT REFERENCES pumps(id) ON DELETE SET NULL,
  owner_id     UUID REFERENCES owners(id) ON DELETE CASCADE,
  nozzle_id    TEXT,
  fuel         TEXT,
  operator     TEXT,
  date         DATE NOT NULL,
  open_reading NUMERIC(12,2) DEFAULT 0,
  close_reading NUMERIC(12,2) DEFAULT 0,
  volume       NUMERIC(10,2) DEFAULT 0,
  rate         NUMERIC(8,2) DEFAULT 0,
  revenue      NUMERIC(10,2) DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- SALES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id     UUID REFERENCES owners(id) ON DELETE CASCADE,
  pump_id      TEXT REFERENCES pumps(id) ON DELETE SET NULL,
  date         DATE NOT NULL,
  petrol       NUMERIC(10,2) DEFAULT 0,
  diesel       NUMERIC(10,2) DEFAULT 0,
  cng          NUMERIC(10,2) DEFAULT 0,
  total        NUMERIC(10,2) DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(owner_id, pump_id, date)
);

-- ─────────────────────────────────────────────
-- TRANSACTIONS (subscription payments)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id           TEXT PRIMARY KEY,
  owner_id     UUID REFERENCES owners(id) ON DELETE CASCADE,
  plan         TEXT,
  billing      TEXT,
  amount       NUMERIC(10,2),
  base         NUMERIC(10,2),
  gst          NUMERIC(10,2),
  credit       NUMERIC(10,2) DEFAULT 0,
  date         DATE NOT NULL,
  method       TEXT DEFAULT 'Demo',
  status       TEXT DEFAULT 'Success',
  razor_id     TEXT,
  plan_activated BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- FUEL PRICES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fuel_prices (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id     UUID REFERENCES owners(id) ON DELETE CASCADE,
  pump_id      TEXT REFERENCES pumps(id) ON DELETE CASCADE,
  petrol       NUMERIC(8,2),
  diesel       NUMERIC(8,2),
  cng          NUMERIC(8,2),
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- MACHINE TESTS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS machine_tests (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id     UUID REFERENCES owners(id) ON DELETE CASCADE,
  pump_id      TEXT REFERENCES pumps(id) ON DELETE SET NULL,
  nozzle_id    TEXT,
  operator     TEXT,
  date         DATE NOT NULL,
  fuel         TEXT,
  result       TEXT CHECK (result IN ('Pass','Fail')),
  note         TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- CREDIT CUSTOMERS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_customers (
  id           TEXT PRIMARY KEY,
  owner_id     UUID REFERENCES owners(id) ON DELETE CASCADE,
  pump_id      TEXT REFERENCES pumps(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  phone        TEXT,
  credit_limit NUMERIC(10,2) DEFAULT 0,
  outstanding  NUMERIC(10,2) DEFAULT 0,
  last_txn     DATE,
  status       TEXT DEFAULT 'Active',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- AUDIT LOG
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      TEXT,
  user_email   TEXT,
  role         TEXT,
  action       TEXT NOT NULL,
  details      JSONB DEFAULT '{}',
  ip           TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- OUTREACH LOG (caller CRM)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_log (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id     UUID REFERENCES owners(id) ON DELETE CASCADE,
  caller_id    UUID REFERENCES company_users(id) ON DELETE SET NULL,
  type         TEXT, -- call, email, whatsapp
  note         TEXT,
  outcome      TEXT,
  follow_up    DATE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- INDEXES for performance
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pumps_owner ON pumps(owner_id);
CREATE INDEX IF NOT EXISTS idx_nozzles_pump ON nozzles(pump_id);
CREATE INDEX IF NOT EXISTS idx_shifts_owner_date ON shift_reports(owner_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_shifts_pump ON shift_reports(pump_id);
CREATE INDEX IF NOT EXISTS idx_sales_owner_date ON sales(owner_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_nozzle_readings_date ON nozzle_readings(owner_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_fuel_prices_pump ON fuel_prices(pump_id, effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_owner ON transactions(owner_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
