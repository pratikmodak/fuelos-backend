const wa = require('../services/whatsapp');
// routes/admin.js — Admin portal: owner management, config, audit
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAdmin, requireSuperAdmin } = require('../middleware/auth');

const addMonths = (d, m) => { const dt = new Date(d); dt.setMonth(dt.getMonth() + m); return dt.toISOString().slice(0,10); };
const today = () => new Date().toISOString().slice(0,10);

// GET /api/admin/stats
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const [owners, txns, pumps, shifts] = await Promise.all([
      db.query(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status='Active') active,
                COUNT(*) FILTER (WHERE status='Suspended') suspended,
                COUNT(*) FILTER (WHERE end_date < CURRENT_DATE AND status!='Suspended') expired
                FROM owners`),
      db.query(`SELECT COALESCE(SUM(base),0) mrr FROM transactions WHERE date >= date_trunc('month',CURRENT_DATE) AND status='Success'`),
      db.query(`SELECT COUNT(*) FROM pumps WHERE status='Active'`),
      db.query(`SELECT COUNT(*) FROM shift_reports WHERE date=CURRENT_DATE`),
    ]);
    res.json({
      total_owners:     parseInt(owners.rows[0].total),
      active_owners:    parseInt(owners.rows[0].active),
      suspended_owners: parseInt(owners.rows[0].suspended),
      expired_owners:   parseInt(owners.rows[0].expired),
      mrr:              parseFloat(txns.rows[0].mrr),
      active_pumps:     parseInt(pumps.rows[0].count),
      shifts_today:     parseInt(shifts.rows[0].count),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/owners
router.get('/owners', requireAdmin, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT o.*, 
         COUNT(DISTINCT p.id) as pump_count,
         COUNT(DISTINCT m.id) as manager_count,
         COUNT(DISTINCT op.id) as operator_count,
         COALESCE(SUM(t.base),0) as total_paid
       FROM owners o
       LEFT JOIN pumps p ON p.owner_id=o.id
       LEFT JOIN managers m ON m.owner_id=o.id
       LEFT JOIN operators op ON op.owner_id=o.id
       LEFT JOIN transactions t ON t.owner_id=o.id AND t.status='Success'
       GROUP BY o.id
       ORDER BY o.created_at DESC`
    );
    res.json(r.rows.map(o => ({
      id: String(o.id), email: o.email, name: o.name, phone: o.phone,
      plan: o.plan, billing: o.billing, status: o.status,
      business_name: o.business_name, city: o.city, gst: o.gst,
      start_date: o.start_date, end_date: o.end_date,
      days_used: o.days_used, amount_paid: parseFloat(o.amount_paid||0),
      created_at: o.created_at,
      pump_count: parseInt(o.pump_count), manager_count: parseInt(o.manager_count),
      operator_count: parseInt(o.operator_count), total_paid: parseFloat(o.total_paid||0),
      expiring_soon: o.end_date && new Date(o.end_date) < new Date(Date.now() + 7*24*60*60*1000),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/owners — create owner
router.post('/owners', requireAdmin, async (req, res) => {
  try {
    const { name, email, phone, password, plan, billing, city, cityCustom, state,
            oil_company, pump_hours, gst, pan, business_name, status } = req.body;
    const hash = await bcrypt.hash(password || 'fuelos123', 10);
    const endDate = addMonths(today(), billing === 'yearly' ? 12 : 1);
    const finalCity = city === 'Other' ? (cityCustom || city) : (city || '');
    const r = await db.query(
      `INSERT INTO owners (email,name,phone,password,plan,billing,status,city,state,
                           business_name,gst,pan,end_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [email, name, phone, hash, plan||'Starter', billing||'monthly', status||'Active',
       finalCity, state||'', business_name||'', gst||'', pan||'', endDate]
    );
    const o = r.rows[0];
    // Audit
    await db.query(`INSERT INTO audit_log (user_email,role,action,details) VALUES ($1,$2,$3,$4)`,
      [req.user.email, req.user.role, `Created owner: ${email}`, JSON.stringify({ plan })]);
    res.json({ ...o, id: String(o.id) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/admin/owners/:id
router.patch('/owners/:id', requireAdmin, async (req, res) => {
  try {
    const { plan, billing, status, extendDays, note } = req.body;
    const id = req.params.id;
    const sets = [], vals = [];

    if (plan)    { vals.push(plan);    sets.push(`plan=$${vals.length}`); }
    if (billing) { vals.push(billing); sets.push(`billing=$${vals.length}`); }
    if (status)  { vals.push(status);  sets.push(`status=$${vals.length}`); }
    if (extendDays) {
      vals.push(extendDays);
      sets.push(`end_date = GREATEST(end_date, CURRENT_DATE) + INTERVAL '${parseInt(extendDays)} days'`);
    }
    if (plan && billing) {
      const endDate = addMonths(today(), billing === 'yearly' ? 12 : 1);
      vals.push(endDate); sets.push(`end_date=$${vals.length}`);
      sets.push(`start_date=CURRENT_DATE`);
    }

    if (sets.length) {
      vals.push(id);
      await db.query(`UPDATE owners SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${vals.length}`, vals);
    }

    await db.query(`INSERT INTO audit_log (user_email,role,action,details) VALUES ($1,$2,$3,$4)`,
      [req.user.email, req.user.role,
       `Updated owner ${id}: ${Object.keys(req.body).join(', ')}`,
       JSON.stringify(req.body)]);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/owners/:id
router.delete('/owners/:id', requireAdmin, async (req, res) => {
  try {
    const hard = req.query.hard === 'true';
    if (hard) {
      await db.query('DELETE FROM owners WHERE id=$1', [req.params.id]);
    } else {
      await db.query("UPDATE owners SET status='Suspended', updated_at=NOW() WHERE id=$1", [req.params.id]);
    }
    await db.query(`INSERT INTO audit_log (user_email,role,action) VALUES ($1,$2,$3)`,
      [req.user.email, req.user.role, `${hard?'Hard deleted':'Suspended'} owner ${req.params.id}`]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/transactions
router.get('/transactions', requireAdmin, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT t.*, o.name as owner_name, o.email as owner_email
       FROM transactions t LEFT JOIN owners o ON o.id=t.owner_id
       ORDER BY t.created_at DESC LIMIT 200`
    );
    res.json(r.rows.map(t => ({
      id: t.id, plan: t.plan, billing: t.billing,
      amount: parseFloat(t.amount||0), base: parseFloat(t.base||0),
      gst: parseFloat(t.gst||0), date: t.date, method: t.method,
      status: t.status, razorId: t.razor_id,
      ownerName: t.owner_name, ownerEmail: t.owner_email,
      ownerId: String(t.owner_id),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/config — reads from DB (persists across restarts + logouts)
router.get('/config', requireAdmin, async (req, res) => {
  try {
    // Auto-create table if missing (fresh DB)
    await db.query(`CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(() => {});
    const r = await db.query('SELECT key, value FROM app_config');
    const cfg = {};
    r.rows.forEach(row => { cfg[row.key] = row.value; });

    // Merge DB config with env vars (DB wins for non-empty values)
    const waKey   = cfg.wa_api_key       || process.env.WA_API_KEY       || '';
    const rzpLive = cfg.rzp_live_key_id  || process.env.RAZORPAY_KEY_ID  || '';
    const rzpTest = cfg.rzp_test_key_id  || '';
    const emailUsr= cfg.email_user       || process.env.EMAIL_USER       || '';

    res.json({
      // Razorpay
      rzp_mode:             cfg.rzp_mode || (rzpLive.startsWith('rzp_live') ? 'live' : 'test'),
      rzp_live_key_id:      rzpLive,
      rzp_live_key_secret:  cfg.rzp_live_key_secret || '',
      rzp_test_key_id:      rzpTest,
      rzp_test_key_secret:  cfg.rzp_test_key_secret || '',
      rzp_webhook_secret:   cfg.rzp_webhook_secret  || '',
      razorpay_enabled:     !!(rzpLive || rzpTest),
      razorpay_mode:        cfg.rzp_mode || 'test',
      // WhatsApp
      wa_provider:          cfg.wa_provider        || 'meta',
      wa_api_key:           waKey,
      wa_phone_number_id:   cfg.wa_phone_number_id || '',
      wa_waba_id:           cfg.wa_waba_id         || '',
      wa_number:            cfg.wa_number          || '',
      wa_verify_token:      cfg.wa_verify_token    || 'fuelos_webhook_verify',
      wa_enabled:           !!waKey,
      // Email
      email_user:           emailUsr,
      email_pass:           cfg.email_pass ? '••••••••' : '',
      email_enabled:        !!emailUsr,
      saved: !!(waKey || rzpLive || rzpTest || emailUsr),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/config — persist config to DB (survives logout + restarts)
router.post('/config', requireAdmin, async (req, res) => {
  try {
    // Auto-create table if missing
    await db.query(`CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(() => {});
    const allowed = [
      'rzp_mode','rzp_live_key_id','rzp_live_key_secret',
      'rzp_test_key_id','rzp_test_key_secret','rzp_webhook_secret',
      'wa_provider','wa_api_key','wa_phone_number_id','wa_waba_id','wa_number','wa_verify_token',
      'email_user','email_pass',
    ];
    const body = req.body || {};
    for (const key of allowed) {
      const val = body[key];
      if (val === undefined || val === null) continue;
      const strVal = String(val).trim();
      if (!strVal || strVal === '••••••••') continue; // skip empty / masked
      await db.query(
        `INSERT INTO app_config (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
        [key, strVal]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/audit  — combined op_log + audit_log, filterable
router.get('/audit', requireAdmin, async (req, res) => {
  try {
    const limit    = Math.min(parseInt(req.query.limit  || '500'), 2000);
    const offset   = parseInt(req.query.offset || '0');
    const role     = req.query.role     || null;
    const category = req.query.category || null;
    const ownerId  = req.query.owner_id || null;
    const search   = req.query.search   || null;

    // Check if op_log exists yet
    const hasOpLog = await db.query(`SELECT to_regclass('op_log') AS t`);
    const opLogExists = !!hasOpLog.rows[0]?.t;

    let rows = [];

    if (opLogExists) {
      let where = [];
      let params = [];
      if (role)     { params.push(role);    where.push(`role=$${params.length}`); }
      if (category) { params.push(category);where.push(`category=$${params.length}`); }
      if (ownerId)  { params.push(ownerId); where.push(`owner_id=$${params.length}`); }
      if (search)   { params.push('%'+search+'%'); where.push(`(action ILIKE $${params.length} OR actor_name ILIKE $${params.length} OR actor_email ILIKE $${params.length})`); }
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      params.push(limit, offset);
      const r = await db.query(
        `SELECT id, owner_id, owner_name, actor_id, actor_name, actor_email,
                role, category, action, entity_type, entity_id, details, ip, created_at
         FROM op_log ${w}
         ORDER BY created_at DESC
         LIMIT $${params.length-1} OFFSET $${params.length}`,
        params
      );
      rows = r.rows.map(a => ({
        id: a.id, source: 'op_log',
        ownerId: a.owner_id, ownerName: a.owner_name,
        user: a.actor_email || a.actor_name || a.actor_id,
        actorName: a.actor_name, actorEmail: a.actor_email,
        role: a.role, category: a.category,
        action: a.action,
        entityType: a.entity_type, entityId: a.entity_id,
        details: a.details,
        time: a.created_at, ip: a.ip,
      }));
    }

    // Also pull from legacy audit_log (admin actions)
    const legacyWhere = [];
    const legacyParams = [];
    if (role && ['superadmin','admin','system'].includes(role)) {
      legacyParams.push(role); legacyWhere.push(`role=$${legacyParams.length}`);
    }
    if (search) {
      legacyParams.push('%'+search+'%');
      legacyWhere.push(`(action ILIKE $${legacyParams.length} OR user_email ILIKE $${legacyParams.length})`);
    }
    legacyParams.push(200);
    const lw = legacyWhere.length ? 'WHERE ' + legacyWhere.join(' AND ') : '';
    const legacy = await db.query(
      `SELECT id, user_email, role, action, details, ip, created_at FROM audit_log ${lw} ORDER BY created_at DESC LIMIT $${legacyParams.length}`,
      legacyParams
    );
    const legacyRows = legacy.rows.map(a => ({
      id: a.id, source: 'audit_log',
      user: a.user_email, actorName: a.user_email,
      role: a.role, category: 'admin',
      action: a.action, details: a.details,
      time: a.created_at, ip: a.ip,
    }));

    // Merge, sort by time desc
    const all = [...rows, ...legacyRows].sort((a,b) => new Date(b.time) - new Date(a.time)).slice(0, limit);

    res.json({ rows: all, total: all.length, opLogExists });
  } catch (e) {
    console.error('[audit]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/backup
router.get('/backup', requireAdmin, async (req, res) => {
  try {
    const [owners, pumps, txns, shifts] = await Promise.all([
      db.query('SELECT id,email,name,plan,status,created_at FROM owners'),
      db.query('SELECT id,owner_id,name,city,status FROM pumps'),
      db.query('SELECT id,owner_id,plan,amount,date,status FROM transactions'),
      db.query('SELECT COUNT(*) FROM shift_reports'),
    ]);
    res.json({
      exported_at: new Date().toISOString(),
      owners: owners.rows,
      pumps: pumps.rows,
      transactions: txns.rows,
      shift_count: parseInt(shifts.rows[0].count),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/admin/operators/:id
router.patch('/operators/:id', requireAdmin, async (req, res) => {
  try {
    const { name, status, shift } = req.body;
    await db.query('UPDATE operators SET name=COALESCE($1,name), status=COALESCE($2,status), shift=COALESCE($3,shift), updated_at=NOW() WHERE id=$4',
      [name, status, shift, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/admin/shifts/:id
router.patch('/shifts/:id', requireAdmin, async (req, res) => {
  try {
    const { status, note } = req.body;
    await db.query('UPDATE shift_reports SET status=COALESCE($1,status), note=COALESCE($2,note) WHERE id=$3',
      [status, note, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/whatsapp-log
// Query params: limit, offset, status, category, owner_id, role
router.get('/whatsapp-log', requireAdmin, async (req, res) => {
  try {
    const limit    = Math.min(parseInt(req.query.limit  || '200'), 500);
    const offset   = parseInt(req.query.offset || '0');
    const status   = req.query.status   || null;
    const category = req.query.category || null;
    const ownerId  = req.query.owner_id || null;
    const role     = req.query.role     || null;

    // Check table exists first
    const tableCheck = await db.query(
      `SELECT to_regclass('wa_messages') AS t`
    );
    if (!tableCheck.rows[0]?.t) return res.json({ rows: [], total: 0 });

    let where = [];
    let params = [];
    if (status)   { params.push(status);   where.push(`w.status=$${params.length}`); }
    if (category) { params.push(category); where.push(`w.category=$${params.length}`); }
    if (ownerId)  { params.push(ownerId);  where.push(`w.owner_id=$${params.length}::text`); }
    if (role)     { params.push(role);     where.push(`w.sender_role=$${params.length}`); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    // Total count
    const countRes = await db.query(`SELECT COUNT(*) FROM wa_messages w ${whereClause}`, params);
    const total = parseInt(countRes.rows[0]?.count || 0);

    // Data with owner info joined
    params.push(limit, offset);
    const r = await db.query(`
      SELECT
        w.id, w.owner_id, w.sender_id, w.sender_role, w.sender_name,
        w.to_phone, w.customer_name, w.message, w.category,
        w.status, w.meta_msg_id, w.error_text,
        w.reply_text, w.reply_at, w.delivered_at, w.read_at, w.created_at,
        o.name AS owner_name, o.email AS owner_email
      FROM wa_messages w
      LEFT JOIN owners o ON o.id::text = w.owner_id
      ${whereClause}
      ORDER BY w.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json({
      rows: r.rows.map(row => ({
        id:           row.id,
        ownerId:      row.owner_id,
        ownerName:    row.owner_name || row.owner_id || '—',
        ownerEmail:   row.owner_email || '—',
        senderId:     row.sender_id,
        senderRole:   row.sender_role,
        senderName:   row.sender_name,
        phone:        row.to_phone,
        customerName: row.customer_name,
        msg:          row.message,
        category:     row.category,
        status:       row.status,
        metaMsgId:    row.meta_msg_id,
        errorText:    row.error_text,
        replyText:    row.reply_text,
        replyAt:      row.reply_at,
        deliveredAt:  row.delivered_at,
        readAt:       row.read_at,
        date:         row.created_at,
      })),
      total,
    });
  } catch (e) {
    console.error('[waLog]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/test-whatsapp — send a real test message to verify integration
router.post('/test-whatsapp', requireAdmin, async (req, res) => {
  try {
    const { to } = req.body;
    // First show what config is loaded so admin can debug
    const cfg = await wa.getWaConfig();
    const configSummary = {
      hasApiKey:       !!cfg.apiKey,
      apiKeyPrefix:    cfg.apiKey ? cfg.apiKey.substring(0, 10) + '...' : '(none)',
      phoneNumberId:   cfg.phoneNumberId || '(none)',
      fromNumber:      cfg.fromNumber    || '(none)',
      sendingTo:       to || cfg.fromNumber || '(none)',
    };
    console.log('[test-whatsapp] config:', configSummary);

    const result = await wa.testConnection(to || '');
    if (result.ok) {
      res.json({ ok: true, messageId: result.messageId, config: configSummary });
    } else {
      res.status(400).json({ ok: false, error: result.error, step: result.step, config: configSummary });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/admin/test-shift-notify — test the full shift notification to a specific owner
router.post('/test-shift-notify', requireAdmin, async (req, res) => {
  try {
    const { owner_id, to } = req.body;
    const wa = require('../services/whatsapp');

    // Get owner phone if owner_id provided
    let phone = to;
    if (!phone && owner_id) {
      const r = await db.query('SELECT whatsapp_num, name FROM owners WHERE id=$1', [owner_id]);
      phone = r.rows[0]?.whatsapp_num;
    }
    if (!phone) return res.status(400).json({ ok: false, error: 'No phone number. Provide to or owner_id with whatsapp_num set.' });

    const result = await wa.notifyShiftSubmitted(phone, {
      pumpName: 'Test Pump', operator: 'Test Operator',
      shift: 'Morning', date: new Date().toISOString().slice(0,10),
      totalRevenue: 12450, cash: 8200, upi: 3100, card: 1150,
      petrolVol: 120, dieselVol: 85,
    });
    res.json({ ok: result.ok, error: result.error, messageId: result.messageId, phone });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;