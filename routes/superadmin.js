// routes/superadmin.js — SuperAdmin / Monitor / Caller portal APIs
const router = require('express').Router();
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

// ════════════════════════════════════════════════
// GET /api/superadmin/overview
// ════════════════════════════════════════════════
router.get('/overview', requireAdmin, async (req, res) => {
  try {
    const [ownersStats, pumpsCount, staffCount, shiftsToday, revenueToday, mrr] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)                                          AS total_owners,
          COUNT(*) FILTER (WHERE status='Active')           AS active_owners,
          COUNT(*) FILTER (WHERE status='Suspended')        AS suspended,
          COUNT(*) FILTER (WHERE plan='Starter')            AS plan_starter,
          COUNT(*) FILTER (WHERE plan='Pro')                AS plan_pro,
          COUNT(*) FILTER (WHERE plan='Enterprise')         AS plan_enterprise,
          COUNT(*) FILTER (WHERE end_date < CURRENT_DATE AND status='Active') AS expired,
          COUNT(*) FILTER (WHERE end_date BETWEEN CURRENT_DATE AND CURRENT_DATE+7 AND status='Active') AS expiring_soon
        FROM owners
      `),
      db.query(`SELECT COUNT(*) FROM pumps WHERE status='Active'`),
      db.query(`SELECT
        (SELECT COUNT(*) FROM managers WHERE status='Active') +
        (SELECT COUNT(*) FROM operators WHERE status='Active') AS total`),
      db.query(`SELECT COUNT(*) FROM shift_reports WHERE date=CURRENT_DATE`),
      db.query(`SELECT COALESCE(SUM(total),0) as rev FROM sales WHERE date=CURRENT_DATE`),
      db.query(`SELECT COALESCE(SUM(base),0) as mrr FROM transactions WHERE date >= date_trunc('month',CURRENT_DATE) AND status='Success'`),
    ]);

    const o = ownersStats.rows[0];
    res.json({
      counts: {
        owners:         parseInt(o.total_owners),
        active_owners:  parseInt(o.active_owners),
        suspended:      parseInt(o.suspended),
        expired:        parseInt(o.expired),
        expiring_soon:  parseInt(o.expiring_soon),
        pumps:          parseInt(pumpsCount.rows[0].count),
        managers:       parseInt(staffCount.rows[0].total || 0),
        operators:      parseInt(staffCount.rows[0].total || 0),
        total_staff:    parseInt(staffCount.rows[0].total || 0),
      },
      plans: {
        Starter:    parseInt(o.plan_starter),
        Pro:        parseInt(o.plan_pro),
        Enterprise: parseInt(o.plan_enterprise),
      },
      today_revenue: parseFloat(revenueToday.rows[0].rev),
      shifts_today:  parseInt(shiftsToday.rows[0].count),
      mrr:           parseFloat(mrr.rows[0].mrr),
    });
  } catch (e) {
    console.error('[superadmin/overview]', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
// GET /api/superadmin/activity — recent platform activity
// ════════════════════════════════════════════════
router.get('/activity', requireAdmin, async (req, res) => {
  try {
    const [logins, shifts, payments, newOwners] = await Promise.all([
      db.query(`SELECT id,email,name,'owner_login' as type,updated_at as time FROM owners WHERE updated_at > NOW()-INTERVAL '7 days' ORDER BY updated_at DESC LIMIT 10`),
      db.query(`SELECT sr.id, o.name as owner_name, sr.pump_id, sr.date, sr.total_revenue, sr.created_at FROM shift_reports sr JOIN owners o ON o.id=sr.owner_id WHERE sr.created_at > NOW()-INTERVAL '7 days' ORDER BY sr.created_at DESC LIMIT 10`),
      db.query(`SELECT t.id,o.name as owner_name,t.plan,t.amount,t.date,t.created_at FROM transactions t JOIN owners o ON o.id=t.owner_id WHERE t.created_at > NOW()-INTERVAL '30 days' ORDER BY t.created_at DESC LIMIT 10`),
      db.query(`SELECT id,email,name,plan,created_at FROM owners WHERE created_at > NOW()-INTERVAL '30 days' ORDER BY created_at DESC LIMIT 5`),
    ]);

    res.json({
      recent_shifts:   shifts.rows,
      recent_payments: payments.rows,
      new_owners:      newOwners.rows,
      recent_logins:   logins.rows,
    });
  } catch (e) {
    console.error('[superadmin/activity]', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
// GET /api/superadmin/subscriptions
// ════════════════════════════════════════════════
router.get('/subscriptions', requireAdmin, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT o.id, o.email, o.name, o.phone, o.plan, o.billing, o.status,
             o.start_date, o.end_date, o.city, o.created_at,
             o.end_date < CURRENT_DATE AS is_expired,
             o.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE+7 AS expiring_soon,
             COUNT(DISTINCT p.id) AS pump_count,
             COALESCE(SUM(t.base),0) AS total_paid
      FROM owners o
      LEFT JOIN pumps p ON p.owner_id=o.id
      LEFT JOIN transactions t ON t.owner_id=o.id AND t.status='Success'
      GROUP BY o.id ORDER BY o.end_date ASC
    `);
    res.json(r.rows.map(o => ({
      id: String(o.id), email: o.email, name: o.name, phone: o.phone,
      plan: o.plan, billing: o.billing, status: o.status,
      start_date: o.start_date, end_date: o.end_date,
      city: o.city, created_at: o.created_at,
      is_expired: o.is_expired, expiring_soon: o.expiring_soon,
      pump_count: parseInt(o.pump_count),
      total_paid: parseFloat(o.total_paid),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
// GET /api/superadmin/health
// ════════════════════════════════════════════════
router.get('/health', requireAdmin, async (req, res) => {
  try {
    const start = Date.now();
    await db.query('SELECT 1');
    const dbLatency = Date.now() - start;
    res.json({
      status:     'ok',
      db:         true,
      db_latency: dbLatency,
      uptime:     process.uptime(),
      memory:     process.memoryUsage().heapUsed,
      version:    process.env.npm_package_version || '3.0.0',
      node:       process.version,
    });
  } catch (e) { res.status(500).json({ status: 'error', db: false, error: e.message }); }
});

// ════════════════════════════════════════════════
// GET /api/superadmin/revenue
// ════════════════════════════════════════════════
router.get('/revenue', requireAdmin, async (req, res) => {
  try {
    const [monthly, byPlan, total] = await Promise.all([
      db.query(`
        SELECT date_trunc('month',date) AS month,
               COALESCE(SUM(base),0) AS revenue,
               COUNT(*) AS transactions
        FROM transactions WHERE status='Success'
        GROUP BY month ORDER BY month DESC LIMIT 12
      `),
      db.query(`
        SELECT plan,
               COALESCE(SUM(base),0) AS revenue,
               COUNT(DISTINCT owner_id) AS owners
        FROM transactions WHERE status='Success'
          AND date >= date_trunc('month',CURRENT_DATE)
        GROUP BY plan
      `),
      db.query(`SELECT COALESCE(SUM(base),0) AS total FROM transactions WHERE status='Success'`),
    ]);
    res.json({
      monthly:    monthly.rows.map(r => ({ month: r.month, revenue: parseFloat(r.revenue), transactions: parseInt(r.transactions) })),
      by_plan:    byPlan.rows.map(r => ({ plan: r.plan, revenue: parseFloat(r.revenue), owners: parseInt(r.owners) })),
      total_arr:  parseFloat(total.rows[0].total),
      mrr:        parseFloat(monthly.rows[0]?.revenue || 0),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
// GET /api/superadmin/shifts
// ════════════════════════════════════════════════
router.get('/shifts', requireAdmin, async (req, res) => {
  try {
    const [stats, recent, topOwners] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE date=CURRENT_DATE) AS today,
          COUNT(*) FILTER (WHERE date >= CURRENT_DATE-7) AS last_7d,
          COALESCE(AVG(total_revenue),0) AS avg_revenue,
          COALESCE(SUM(total_revenue),0) AS total_revenue
        FROM shift_reports
        WHERE date >= CURRENT_DATE - 30
      `),
      db.query(`
        SELECT sr.*, o.name AS owner_name, p.name AS pump_name
        FROM shift_reports sr
        JOIN owners o ON o.id=sr.owner_id
        LEFT JOIN pumps p ON p.id=sr.pump_id
        ORDER BY sr.created_at DESC LIMIT 20
      `),
      db.query(`
        SELECT o.id, o.name, COUNT(sr.id) AS shift_count, COALESCE(SUM(sr.total_revenue),0) AS revenue
        FROM shift_reports sr JOIN owners o ON o.id=sr.owner_id
        WHERE sr.date >= CURRENT_DATE-30
        GROUP BY o.id, o.name ORDER BY shift_count DESC LIMIT 10
      `),
    ]);
    const s = stats.rows[0];
    res.json({
      stats: {
        total: parseInt(s.total), today: parseInt(s.today), last_7d: parseInt(s.last_7d),
        avg_revenue: parseFloat(s.avg_revenue), total_revenue: parseFloat(s.total_revenue),
      },
      recent: recent.rows,
      top_owners: topOwners.rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
// GET /api/superadmin/tests
// ════════════════════════════════════════════════
router.get('/tests', requireAdmin, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE result='Pass') AS pass,
        COUNT(*) FILTER (WHERE result='Fail') AS fail
      FROM machine_tests WHERE date >= CURRENT_DATE-30
    `);
    const t = r.rows[0];
    res.json({
      total: parseInt(t.total), pass: parseInt(t.pass), fail: parseInt(t.fail),
      pass_rate: t.total > 0 ? Math.round(t.pass / t.total * 100) : 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
// GET /api/superadmin/tanks
// ════════════════════════════════════════════════
router.get('/tanks', requireAdmin, async (req, res) => {
  // Tanks are stored locally in frontend; this endpoint returns platform-level summary
  res.json({ total: 0, low_stock: 0, critical: 0, by_fuel: {} });
});

// ════════════════════════════════════════════════
// GET /api/superadmin/credits
// ════════════════════════════════════════════════
router.get('/credits', requireAdmin, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT
        COUNT(*) AS total_customers,
        COALESCE(SUM(outstanding),0) AS total_outstanding,
        COALESCE(SUM(credit_limit),0) AS total_limit,
        COUNT(*) FILTER (WHERE outstanding >= credit_limit*0.9) AS near_limit
      FROM credit_customers WHERE status='Active'
    `);
    const c = r.rows[0];
    res.json({
      total_customers:   parseInt(c.total_customers),
      total_outstanding: parseFloat(c.total_outstanding),
      total_limit:       parseFloat(c.total_limit),
      near_limit:        parseInt(c.near_limit),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
// GET /api/superadmin/whatsapp
// ════════════════════════════════════════════════
router.get('/whatsapp', requireAdmin, async (req, res) => {
  // Placeholder — integrate with WA provider for real delivery stats
  res.json({
    enabled: !!(process.env.WA_API_KEY),
    saved: !!(process.env.WA_API_KEY),
    delivery_rate: 0,
    sent_today: 0,
    sent_month: 0,
    failed: 0,
    by_owner: [],
  });
});

// ════════════════════════════════════════════════
// GET /api/superadmin/platform-analytics
// ════════════════════════════════════════════════
router.get('/platform-analytics', requireAdmin, async (req, res) => {
  try {
    const [growth, fuel, top] = await Promise.all([
      db.query(`
        SELECT date_trunc('month',created_at) AS month, COUNT(*) AS new_owners
        FROM owners GROUP BY month ORDER BY month DESC LIMIT 12
      `),
      db.query(`
        SELECT
          COALESCE(SUM(petrol),0) AS petrol,
          COALESCE(SUM(diesel),0) AS diesel,
          COALESCE(SUM(cng),0) AS cng
        FROM sales WHERE date >= CURRENT_DATE-30
      `),
      db.query(`
        SELECT o.id, o.name, o.plan, COALESCE(SUM(s.total),0) AS revenue
        FROM owners o LEFT JOIN sales s ON s.owner_id=o.id AND s.date >= CURRENT_DATE-30
        GROUP BY o.id, o.name, o.plan ORDER BY revenue DESC LIMIT 10
      `),
    ]);
    const f = fuel.rows[0];
    res.json({
      owner_growth: growth.rows.map(r => ({ month: r.month, count: parseInt(r.new_owners) })),
      fuel_volumes: { petrol: parseFloat(f.petrol), diesel: parseFloat(f.diesel), cng: parseFloat(f.cng) },
      top_owners:   top.rows.map(o => ({ id: String(o.id), name: o.name, plan: o.plan, revenue: parseFloat(o.revenue) })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
// GET /api/superadmin/contacts — Caller CRM
// ════════════════════════════════════════════════
router.get('/contacts', requireAdmin, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT o.id, o.name, o.email, o.phone, o.plan, o.status, o.end_date, o.city,
             ol.type AS last_contact_type, ol.note AS last_contact_note,
             ol.created_at AS last_contact_at, ol.follow_up
      FROM owners o
      LEFT JOIN LATERAL (
        SELECT * FROM outreach_log WHERE owner_id=o.id ORDER BY created_at DESC LIMIT 1
      ) ol ON TRUE
      ORDER BY o.end_date ASC
    `);
    res.json(r.rows.map(o => ({ ...o, id: String(o.id) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/superadmin/outreach-log
router.post('/outreach-log', requireAdmin, async (req, res) => {
  try {
    const { owner_id, type, note, outcome, follow_up } = req.body;
    await db.query(
      `INSERT INTO outreach_log (owner_id,caller_id,type,note,outcome,follow_up)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [owner_id, req.user.id, type, note, outcome, follow_up || null]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/superadmin/remind/:userId
router.post('/remind/:userId', requireAdmin, async (req, res) => {
  try {
    const owner = (await db.query('SELECT * FROM owners WHERE id=$1', [req.params.userId])).rows[0];
    if (!owner) return res.status(404).json({ error: 'Owner not found' });
    // In production: send renewal reminder email/WA
    console.log(`[Reminder] Sending to ${owner.email} (plan: ${owner.plan}, expires: ${owner.end_date})`);
    await db.query(`INSERT INTO audit_log (user_email,role,action) VALUES ($1,$2,$3)`,
      [req.user.email, req.user.role, `Sent renewal reminder to ${owner.email}`]);
    res.json({ ok: true, sent_to: owner.email });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
