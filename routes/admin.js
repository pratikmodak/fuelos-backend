// ═══════════════════════════════════════════════════════════
// FuelOS — Admin Routes
// GET/POST /api/admin/config        — integration config
// GET      /api/admin/owners        — all owners + stats
// PATCH    /api/admin/owners/:id    — change plan / status
// GET      /api/admin/stats         — platform overview
// ═══════════════════════════════════════════════════════════
import { Router }   from 'express';
import { v4 as uuid } from 'uuid';
import { db }       from '../db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);
router.use(requireRole('admin'));

// ── Integration config ─────────────────────────────────
// GET /api/admin/config
router.get('/config', (req, res) => {
  const rows = db.all('SELECT key, value FROM integration_config');
  // Mask secrets in response
  const cfg = Object.fromEntries(rows.map(r => {
    const isSecret = r.key.includes('secret') || r.key.includes('token') || r.key.includes('password');
    return [r.key, isSecret && r.value ? '••••••••' : r.value];
  }));
  res.json(cfg);
});

// POST /api/admin/config — save integration keys
router.post('/config', (req, res) => {
  const upsert = db.run.bind(db,
    `INSERT INTO integration_config(key,value,updated_at) VALUES(?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`);

  const allowed = [
    'rzp_mode', 'rzp_live_key_id', 'rzp_live_key_secret',
    'rzp_test_key_id', 'rzp_test_key_secret', 'rzp_webhook_secret',
    'rzp_currency', 'rzp_auto_capture', 'rzp_send_receipt',
    'wa_provider', 'wa_api_key', 'wa_phone_number_id', 'wa_waba_id',
    'wa_twilio_account_sid', 'wa_twilio_auth_token', 'wa_twilio_from',
    'wa_wati_key', 'wa_namespace', 'wa_number',
    'wa_tpl_payment', 'wa_tpl_shift', 'wa_tpl_alert', 'wa_tpl_test',
    'email_provider', 'email_host', 'email_port', 'email_user',
    'email_pass', 'email_from', 'email_secure',
    'sms_provider', 'sms_api_key', 'sms_sender_id', 'sms_dlt_id',
  ];

  for (const [key, value] of Object.entries(req.body)) {
    if (allowed.includes(key) && value !== '••••••••') {
      upsert([key, value]);
    }
  }

  db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
    [uuid(), 'admin@fuelos.in', 'Admin', 'Integration config updated', req.ip]);

  res.json({ success: true });
});

// ── Owners ─────────────────────────────────────────────
// GET /api/admin/owners
router.get('/owners', (req, res) => {
  const owners = db.all('SELECT * FROM owners ORDER BY created_at DESC');
  const enriched = owners.map(o => {
    const txns    = db.all('SELECT * FROM transactions WHERE owner_id=?', [o.id]);
    const waMsgs  = db.all('SELECT * FROM wa_log WHERE owner_id=?', [o.id]);
    const pumps   = db.all('SELECT id FROM pumps WHERE owner_id=?', [o.id]);
    return {
      ...o, password_hash: undefined,
      pumps: pumps.length,
      transactions: txns,
      paidAmt: txns.filter(t => t.status === 'Success').reduce((s, t) => s + t.amount, 0),
      failedPayments: txns.filter(t => t.status === 'Failed').length,
      waSent: waMsgs.filter(w => w.status === 'Delivered').length,
      waFailed: waMsgs.filter(w => w.status === 'Failed').length,
      waTotal: waMsgs.length,
    };
  });
  res.json(enriched);
});

// PATCH /api/admin/owners/:id — change plan / status / extend
router.patch('/owners/:id', (req, res) => {
  const { id } = req.params;
  const { plan, status, extendDays } = req.body;

  const owner = db.get('SELECT * FROM owners WHERE id=?', [id]);
  if (!owner) return res.status(404).json({ error: 'Owner not found' });

  if (plan) {
    const endDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    db.run(`UPDATE owners SET plan=?, status='Active', start_date=date('now'), end_date=?, days_used=0, updated_at=datetime('now') WHERE id=?`,
      [plan, endDate, id]);
    db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [uuid(), 'admin@fuelos.in', 'Admin', `Admin force-changed plan → ${plan} for ${owner.name}`, req.ip]);
  }

  if (status) {
    db.run(`UPDATE owners SET status=?, updated_at=datetime('now') WHERE id=?`, [status, id]);
  }

  if (extendDays) {
    db.run(`UPDATE owners SET end_date=date(end_date,'+'||?||' days'), updated_at=datetime('now') WHERE id=?`,
      [extendDays, id]);
  }

  res.json(db.get('SELECT * FROM owners WHERE id=?', [id]));
});

// ── Platform stats ────────────────────────────────────
// GET /api/admin/stats
router.get('/stats', (req, res) => {
  const owners     = db.all('SELECT * FROM owners');
  const txns       = db.all('SELECT * FROM transactions');
  const pumps      = db.all('SELECT * FROM pumps');
  const waStats    = db.all('SELECT * FROM v_wa_stats');
  const failedTxns = db.all("SELECT * FROM v_failed_payments");
  const services   = [
    { name: 'Razorpay Gateway',        status: 'Online', latency: 112, uptime: 99.97 },
    { name: 'Authentication API',       status: 'Online', latency: 38,  uptime: 99.99 },
    { name: 'WhatsApp Notifications',   status: 'Online', latency: 340, uptime: 98.20 },
    { name: 'Database',                 status: 'Online', latency: 2,   uptime: 99.99 },
  ];

  const mrr = owners
    .filter(o => o.status === 'Active')
    .reduce((s, o) => s + ({ Starter: 799, Pro: 2499, Enterprise: 5999 }[o.plan] || 0), 0);

  res.json({
    owners:    owners.length,
    active:    owners.filter(o => o.status === 'Active').length,
    pumps:     pumps.length,
    mrr,
    txnOk:     txns.filter(t => t.status === 'Success').length,
    txnFailed: txns.filter(t => t.status === 'Failed').length,
    waStats,
    failedTxns,
    services,
    planDistribution: {
      Starter:    owners.filter(o => o.plan === 'Starter').length,
      Pro:        owners.filter(o => o.plan === 'Pro').length,
      Enterprise: owners.filter(o => o.plan === 'Enterprise').length,
    },
  });
});

// GET /api/admin/audit
router.get('/audit', (req, res) => {
  const logs = db.all('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 500');
  res.json(logs);
});

// GET /api/admin/transactions
router.get('/transactions', (req, res) => {
  const txns = db.all(`
    SELECT t.*, o.name as owner_name, o.email as owner_email
    FROM transactions t
    LEFT JOIN owners o ON t.owner_id = o.id
    ORDER BY t.created_at DESC
  `);
  res.json(txns);
});

// POST /api/admin/transactions/:id/retry — retry failed payment (admin override)
router.post('/transactions/:id/retry', (req, res) => {
  const txn = db.get('SELECT * FROM transactions WHERE id=?', [req.params.id]);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });

  const endDate = txn.billing === 'yearly'
    ? new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10)
    : new Date(Date.now() +  30  * 86400000).toISOString().slice(0, 10);

  db.tx(() => {
    db.run(`UPDATE transactions SET status='Success', plan_activated=1, updated_at=datetime('now') WHERE id=?`, [txn.id]);
    db.run(`UPDATE owners SET plan=?, status='Active', start_date=date('now'), end_date=?, days_used=0, updated_at=datetime('now') WHERE id=?`,
      [txn.plan, endDate, txn.owner_id]);
    db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [uuid(), 'admin@fuelos.in', 'Admin', `Admin manually activated ${txn.plan} plan for txn ${txn.id}`, req.ip]);
  });

  res.json({ success: true });
});

export default router;
