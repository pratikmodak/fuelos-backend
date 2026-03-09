// ═══════════════════════════════════════════════════════════
// FuelOS v3 — Audit Logging Middleware
// logs every significant operation by owner/manager/operator
// ═══════════════════════════════════════════════════════════
const db = require('../db');

// Ensure op_log table exists (richer than audit_log)
const ensureOpLog = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS op_log (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT,
      owner_name  TEXT,
      actor_id    TEXT,
      actor_name  TEXT,
      actor_email TEXT,
      role        TEXT,
      category    TEXT,   -- shift | credit | fuel | pump | staff | expense | login | account
      action      TEXT,   -- human-readable e.g. "Submitted shift"
      entity_type TEXT,   -- shift_report | credit_customer | pump | ...
      entity_id   TEXT,
      details     JSONB DEFAULT '{}',
      ip          TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_oplog_owner   ON op_log(owner_id, created_at DESC)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_oplog_actor   ON op_log(actor_id, created_at DESC)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_oplog_created ON op_log(created_at DESC)`).catch(() => {});
};

ensureOpLog();

const nanoid = () => 'op_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

// Core logger — call from any route
// logOp(req, { category, action, entityType, entityId, details, ownerId, ownerName })
const logOp = async (req, opts = {}) => {
  try {
    const u = req.user || {};
    const ownerId   = opts.ownerId   || u.owner_id || (u.role === 'owner' ? u.id : null);
    const ownerName = opts.ownerName || u.owner_name || null;
    const ip        = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || null;

    await db.query(
      `INSERT INTO op_log
         (id, owner_id, owner_name, actor_id, actor_name, actor_email, role,
          category, action, entity_type, entity_id, details, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        nanoid(),
        ownerId    ? String(ownerId)    : null,
        ownerName,
        u.id       ? String(u.id)       : null,
        u.name     || null,
        u.email    || null,
        u.role     || 'unknown',
        opts.category   || 'other',
        opts.action     || 'unknown action',
        opts.entityType || null,
        opts.entityId   ? String(opts.entityId) : null,
        JSON.stringify(opts.details || {}),
        ip,
      ]
    );
  } catch (e) {
    // Never crash the request due to logging failure
    console.warn('[OpLog] Failed to log:', e.message);
  }
};

module.exports = { logOp };
