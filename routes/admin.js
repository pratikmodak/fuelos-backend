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

// GET /api/admin/audit
router.get('/audit', requireAdmin, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 500'
    );
    res.json(r.rows.map(a => ({
      id: a.id, user: a.user_email, role: a.role,
      action: a.action, time: a.created_at, ip: a.ip,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// GET /api/whatsapp/log
router.get('/whatsapp-log', requireAdmin, async (req, res) => {
  // Placeholder — integrate with actual WA provider for logs
  res.json([]);
});

module.exports = router;