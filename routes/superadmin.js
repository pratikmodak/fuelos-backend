// routes/superadmin.js — SuperAdmin / Monitor / Caller portal APIs
const router = require('express').Router();
const db = require('../db');
const { staffFollowup, resolveLang } = require('../wa-messages');
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
// GET /api/superadmin/activity — staff usage monitor + recent platform activity
// ════════════════════════════════════════════════
router.get('/activity', requireAdmin, async (req, res) => {
  try {
    const [mgrsRes, opsRes, shiftsRes, paymentsRes, newOwnersRes] = await Promise.all([

      // Managers — with last activity derived from shift_reports or op_log
      db.query(`
        SELECT
          m.id, m.name, m.email, m.phone, m.owner_id, m.pump_id,
          m.shift, m.status, COALESCE(m.lang_pref,'en') AS lang_pref,
          o.name  AS owner_name,
          p.name  AS pump_name,
          'Manager' AS role,
          -- last activity = most recent shift submitted OR op_log entry
          GREATEST(
            (SELECT MAX(sr.created_at) FROM shift_reports sr WHERE sr.owner_id = m.owner_id AND sr.created_at > NOW() - INTERVAL '30 days'),
            (SELECT MAX(ol.created_at) FROM op_log ol WHERE ol.actor_id = m.id::text AND ol.created_at > NOW() - INTERVAL '30 days')
          ) AS last_active,
          -- 7-day shift count as proxy for logins
          (SELECT COUNT(*) FROM shift_reports sr WHERE sr.owner_id = m.owner_id AND sr.created_at > NOW() - INTERVAL '7 days') AS logins7d
        FROM managers m
        LEFT JOIN owners o ON o.id = m.owner_id
        LEFT JOIN pumps  p ON p.id = m.pump_id
        WHERE m.status = 'Active'
        ORDER BY last_active DESC NULLS LAST
      `),

      // Operators — with last activity from shift_reports (they submit shifts)
      db.query(`
        SELECT
          op.id, op.name, op.email, op.phone, op.owner_id, op.pump_id,
          op.shift, op.status, op.points, op.streak, COALESCE(op.lang_pref,'en') AS lang_pref,
          o.name  AS owner_name,
          p.name  AS pump_name,
          'Operator' AS role,
          -- last activity = most recent shift they're in
          (SELECT MAX(sr.created_at) FROM shift_reports sr
           WHERE sr.operator_id = op.id AND sr.created_at > NOW() - INTERVAL '30 days'
          ) AS last_active,
          -- 7-day shift count
          (SELECT COUNT(*) FROM shift_reports sr
           WHERE sr.operator_id = op.id AND sr.created_at > NOW() - INTERVAL '7 days'
          ) AS logins7d
        FROM operators op
        LEFT JOIN owners o ON o.id = op.owner_id
        LEFT JOIN pumps  p ON p.id = op.pump_id
        WHERE op.status = 'Active'
        ORDER BY last_active DESC NULLS LAST
      `),

      // Recent shifts across all owners
      db.query(`
        SELECT sr.id, o.name AS owner_name, sr.pump_id, sr.date,
               sr.total_revenue, sr.created_at, sr.operator, sr.shift
        FROM shift_reports sr
        JOIN owners o ON o.id = sr.owner_id
        WHERE sr.created_at > NOW() - INTERVAL '7 days'
        ORDER BY sr.created_at DESC LIMIT 15
      `),

      // Recent payments
      db.query(`
        SELECT t.id, o.name AS owner_name, t.plan, t.amount, t.date, t.created_at
        FROM transactions t
        JOIN owners o ON o.id = t.owner_id
        WHERE t.created_at > NOW() - INTERVAL '30 days'
        ORDER BY t.created_at DESC LIMIT 10
      `),

      // New owners
      db.query(`
        SELECT id, email, name, plan, created_at
        FROM owners
        WHERE created_at > NOW() - INTERVAL '30 days'
        ORDER BY created_at DESC LIMIT 5
      `),
    ]);

    // Calculate days_inactive and compliance for each staff member
    const calcStaff = (rows) => rows.map(u => {
      const lastActive = u.last_active ? new Date(u.last_active) : null;
      const now        = new Date();
      const daysInactive = lastActive
        ? Math.floor((now - lastActive) / 86400000)
        : 999; // never active

      const compliance =
        daysInactive === 0   ? 'compliant' :
        daysInactive === 1   ? 'reminder'  :
        daysInactive >= 2    ? 'non-compliant' : 'never';

      return {
        id:           String(u.id),
        name:         u.name,
        email:        u.email,
        phone:        u.phone,
        role:         u.role,
        pump:         u.pump_name || u.pump_id || '—',
        pumpId:       u.pump_id,
        ownerName:    u.owner_name || '—',
        ownerId:      String(u.owner_id),
        shift:        u.shift,
        lang_pref:    u.lang_pref || 'en',
        last_login:   u.last_active || null,
        days_inactive: daysInactive === 999 ? null : daysInactive,
        logins7d:     parseInt(u.logins7d || 0),
        compliance,
        points:       u.points || 0,
        streak:       u.streak  || 0,
      };
    });

    res.json({
      managers:        calcStaff(mgrsRes.rows),
      operators:       calcStaff(opsRes.rows),
      recent_shifts:   shiftsRes.rows,
      recent_payments: paymentsRes.rows,
      new_owners:      newOwnersRes.rows,
      // Legacy field — keep for backward compat
      recent_logins:   [],
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
    // 1. Database
    const dbStart = Date.now();
    await db.query('SELECT 1');
    const dbLatency = Date.now() - dbStart;

    // 2. Razorpay (payment gateway)
    const razorpayKey = process.env.RAZORPAY_KEY_ID || '';
    const razorpayOk  = !!razorpayKey;
    const razorpayMode = razorpayKey.startsWith('rzp_live') ? 'live' : razorpayKey ? 'test' : null;

    // 3. Email / SMTP
    const emailOk = !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);

    // 4. WhatsApp API
    const waOk  = !!(process.env.WA_API_KEY);
    const waSrc = process.env.WA_SOURCE || null;

    // 5. Anthropic AI (Claude insights)
    const aiOk = !!(process.env.ANTHROPIC_API_KEY);

    // 6. RapidAPI (live fuel prices)
    const rapidOk = !!(process.env.RAPIDAPI_KEY);

    // 7. Count recent WA messages
    let waMessages = null, waDelivered = null;
    if (waOk) {
      try {
        const wr = await db.query(
          `SELECT COUNT(*) AS sent,
                  COUNT(*) FILTER (WHERE status='delivered') AS delivered
           FROM notifications
           WHERE created_at >= NOW() - INTERVAL '24 hours'`
        );
        waMessages  = parseInt(wr.rows[0]?.sent     || 0);
        waDelivered = parseInt(wr.rows[0]?.delivered || 0);
      } catch {}
    }

    // 8. Recent payment transactions
    let txns24h = null, failed24h = null;
    try {
      const tr = await db.query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status != 'Success') AS failed
         FROM transactions
         WHERE created_at >= NOW() - INTERVAL '24 hours'`
      );
      txns24h  = parseInt(tr.rows[0]?.total  || 0);
      failed24h = parseInt(tr.rows[0]?.failed || 0);
    } catch {}

    const services = [
      {
        name:       'PostgreSQL Database',
        type:       'database',
        icon:       '🗄️',
        status:     'Online',
        latency_ms: dbLatency,
        version:    null,
      },
      {
        name:       'Razorpay Payments',
        type:       'payment-gateway',
        icon:       '💳',
        status:     razorpayOk ? 'Active' : 'Not Configured',
        version:    razorpayMode,
        txns_24h:   txns24h,
        failed_24h: failed24h,
      },
      {
        name:       'WhatsApp Messaging',
        type:       'messaging',
        icon:       '📱',
        status:     waOk ? 'Active' : 'Not Configured',
        messages_24h:  waMessages,
        delivered_24h: waDelivered,
      },
      {
        name:       'Email / SMTP',
        type:       'email',
        icon:       '📧',
        status:     emailOk ? 'Active' : 'Not Configured',
      },
      {
        name:       'Anthropic AI (Claude)',
        type:       'ai-api',
        icon:       '🤖',
        status:     aiOk ? 'Active' : 'Not Configured',
      },
      {
        name:       'RapidAPI Fuel Prices',
        type:       'market-data',
        icon:       '⛽',
        status:     rapidOk ? 'Active' : 'Not Configured',
      },
    ];

    res.json({
      status:     'ok',
      db:         true,
      db_latency: dbLatency,
      uptime:     Math.round(process.uptime()),
      memory_mb:  Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      version:    process.env.npm_package_version || '3.0.0',
      node:       process.version,
      services,
    });
  } catch (e) { res.status(500).json({ status: 'error', db: false, error: e.message, services: [] }); }
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
             o.whatsapp_num,
             o.grace_until, o.grace_wa_day5, o.grace_wa_day15, o.grace_wa_day25, o.grace_granted_at,
             (SELECT COUNT(*) FROM pumps WHERE owner_id=o.id) AS pump_count,
             ol.type AS last_contact_type, ol.note AS last_contact_note,
             ol.created_at AS last_contact_at, ol.follow_up,
             CASE WHEN o.grace_until IS NOT NULL AND o.grace_until >= CURRENT_DATE
               THEN (o.grace_until::date - CURRENT_DATE)
               WHEN o.end_date IS NOT NULL
               THEN (o.end_date::date - CURRENT_DATE)
               ELSE NULL
             END AS days_left,
             CASE WHEN o.grace_until IS NOT NULL AND o.end_date < CURRENT_DATE THEN TRUE ELSE FALSE END AS in_grace
      FROM owners o
      LEFT JOIN LATERAL (
        SELECT * FROM outreach_log WHERE owner_id=o.id ORDER BY created_at DESC LIMIT 1
      ) ol ON TRUE
      ORDER BY o.end_date ASC NULLS LAST
    `);
    res.json(r.rows.map(o => {
      const dl = o.days_left !== null && o.days_left !== undefined ? parseInt(o.days_left) : null;
      return {
        ...o,
        id:         String(o.id),
        days_left:  dl,
        pump_count: parseInt(o.pump_count || 0),
        in_grace:   o.in_grace || false,
        priority:   dl === null ? 'normal' : dl <= 3 ? 'urgent' : dl <= 7 ? 'high' : 'normal',
      };
    }));
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

// ── GRACE PERIOD HELPERS ────────────────────────────────────────────

const WA_TOKEN_SA    = process.env.WA_TOKEN;
const WA_PHONE_ID_SA = process.env.WA_PHONE_ID;


function buildRenewalMsg(owner) {
  const expDate = owner.end_date
    ? new Date(owner.end_date).toLocaleDateString('en-IN', {day:'numeric',month:'long',year:'numeric'})
    : '---';
  const graceDate = owner.grace_until
    ? new Date(owner.grace_until).toLocaleDateString('en-IN', {day:'numeric',month:'long',year:'numeric'})
    : null;
  const lines = [
    '\uD83D\uDD14 *FuelOS Subscription Renewal Reminder*',
    '',
    'Hi ' + owner.name + ',',
    '',
    '\u26A0\uFE0F Your *' + owner.plan + '* plan expired on *' + expDate + '*.',
  ];
  if (graceDate) {
    lines.push('\u2705 Your account is active during grace period until *' + graceDate + '*.');
    lines.push('\uD83D\uDCB3 Please renew before ' + graceDate + ' to avoid suspension.');
  } else {
    lines.push('\u2757 Please renew your subscription immediately to avoid service interruption.');
  }
  lines.push('', '\uD83D\uDC49 Login \u2192 Billing \u2192 Renew Plan', '', 'Thank you! \uD83D\uDE4F - FuelOS Team');
  return lines.join('\n');
}


async function sendRenewalWA(owner, customMsg) {
  const rawPhone = owner.whatsapp_num || owner.phone || '';
  const phone    = rawPhone.replace(/\D/g,'');
  if (!phone) return { ok: false, reason: 'no_phone' };
  if (!WA_TOKEN_SA || !WA_PHONE_ID_SA) return { ok: false, reason: 'no_credentials' };

  const to   = phone.startsWith('91') ? phone : '91' + phone;
  const body = customMsg || buildRenewalMsg(owner);

  try {
    const r = await fetch('https://graph.facebook.com/v19.0/' + WA_PHONE_ID_SA + '/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', Authorization: 'Bearer ' + WA_TOKEN_SA },
      body: JSON.stringify({ messaging_product:'whatsapp', to, type:'text', text:{ body } }),
    });
    const d = await r.json();
    if (!r.ok) return { ok: false, reason: d?.error?.message || 'Meta API error' };

    // Log to wa_messages
    const logId = 'grace_' + owner.id + '_' + Date.now();
    await db.query(
      `INSERT INTO wa_messages (id,owner_id,sender_id,sender_role,sender_name,to_phone,customer_name,message,category,status,meta_msg_id)
       VALUES ($1,$2,'system','system','FuelOS Admin',$3,$4,$5,'renewal','sent',$6) ON CONFLICT DO NOTHING`,
      [logId, String(owner.id), to, owner.name, body, d?.messages?.[0]?.id || null]
    ).catch(()=>{});

    return { ok: true, to };
  } catch(e) {
    return { ok: false, reason: e.message };
  }
}


// PATCH /api/superadmin/contacts/:userId/lang — set language preference
router.patch('/contacts/:userId/lang', requireAdmin, async (req, res) => {
  try {
    const { lang } = req.body; // 'en' | 'mr'
    if (!['en','mr'].includes(lang)) return res.status(400).json({ error: 'lang must be en or mr' });
    const r = await db.query(
      `UPDATE owners SET lang_pref=$1, updated_at=NOW() WHERE id=$2 RETURNING id, lang_pref`,
      [lang, req.params.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Owner not found' });
    res.json({ ok: true, lang });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/superadmin/remind/:userId — manual WA renewal reminder
router.post('/remind/:userId', requireAdmin, async (req, res) => {
  try {
    const owner = (await db.query('SELECT * FROM owners WHERE id=$1', [req.params.userId])).rows[0];
    if (!owner) return res.status(404).json({ error: 'Owner not found' });

    const result = await sendRenewalWA(owner, req.body?.message || null);

    await db.query(`INSERT INTO audit_log (user_email,role,action) VALUES ($1,$2,$3)`,
      [req.user.email, req.user.role,
       `Manual WA renewal reminder → ${owner.name} (${owner.email}) | result: ${result.ok ? 'sent' : result.reason}`]);

    res.json({ ok: true, wa: result, owner: owner.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});



// POST /api/superadmin/bulk-followup — send WA to multiple inactive staff
// body: { staffList: [{ id, role, name, phone, owner_name, lang_pref }] }
router.post('/bulk-followup', requireAdmin, async (req, res) => {
  try {
    const { staffList = [] } = req.body;
    if (!staffList.length) return res.status(400).json({ error: 'staffList is empty' });

    const WA_TOKEN    = process.env.WA_TOKEN;
    const WA_PHONE_ID = process.env.WA_PHONE_ID;
    const results = [];

    for (const staff of staffList) {
      const phone = (staff.phone || '').replace(/\D/g, '');
      if (!phone) { results.push({ id: staff.id, name: staff.name, ok: false, reason: 'no_phone' }); continue; }
      const to   = phone.startsWith('91') ? phone : '91' + phone;
      const lang = staff.lang_pref || 'en';
      const msg  = staffFollowup(staff, staff.owner_name, lang);

      let waResult = { ok: false, reason: 'WA not configured' };
      if (WA_TOKEN && WA_PHONE_ID) {
        try {
          const waRes = await fetch(
            `https://graph.facebook.com/v18.0/${WA_PHONE_ID}/messages`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: msg } })
            }
          );
          const d = await waRes.json();
          waResult = d.messages?.length
            ? { ok: true, meta_msg_id: d.messages[0].id }
            : { ok: false, reason: d.error?.message || 'Unknown WA error' };
        } catch (err) { waResult = { ok: false, reason: err.message }; }

        // Log to wa_messages
        try {
          await db.query(
            `INSERT INTO wa_messages (id,owner_id,sender_id,sender_role,sender_name,to_phone,customer_name,message,category,status,meta_msg_id,error_text)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'other',$9,$10,$11)`,
            [
              'wam_' + Date.now() + '_' + staff.id.slice(0,6),
              String(staff.owner_id || ''),
              req.user.id || req.user.email,
              req.user.role,
              req.user.name || req.user.email,
              to, staff.name, msg,
              waResult.ok ? 'sent' : 'failed',
              waResult.meta_msg_id || null,
              waResult.ok ? null : waResult.reason,
            ]
          );
        } catch (_) {}
      }

      results.push({ id: staff.id, name: staff.name, phone: to, ...waResult });
      // Small delay to avoid Meta rate limits
      await new Promise(r => setTimeout(r, 300));
    }

    const sent   = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    await db.query(
      `INSERT INTO audit_log (user_email,role,action) VALUES ($1,$2,$3)`,
      [req.user.email, req.user.role, `Bulk WA follow-up → ${sent} sent, ${failed} failed of ${staffList.length} staff`]
    );

    res.json({ ok: true, sent, failed, total: staffList.length, results });
  } catch (e) {
    console.error('[bulk-followup]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/superadmin/staff-followup/:staffId — send WA to a manager or operator
// staffId is a manager or operator UUID, role = 'manager' | 'operator'
router.post('/staff-followup/:staffId', requireAdmin, async (req, res) => {
  try {
    const { role } = req.body; // 'manager' or 'operator'
    const roleNorm = (role||'').toLowerCase();
    const table = roleNorm === 'manager' ? 'managers' : 'operators';

    const staffRes = await db.query(
      `SELECT s.id, s.name, s.phone, s.email, s.owner_id,
              COALESCE(s.lang_pref, 'en') AS lang_pref,
              o.name AS owner_name, o.whatsapp_num, o.whatsapp,
              'en' AS owner_lang_pref
       FROM ${table} s
       LEFT JOIN owners o ON o.id = s.owner_id
       WHERE s.id = $1`,
      [req.params.staffId]
    );

    const staff = staffRes.rows[0];
    if (!staff) return res.status(404).json({ error: 'Staff member not found' });

    // Send WA to staff member's phone if available, otherwise owner's phone
    const phone = staff.phone || staff.whatsapp_num;
    if (!phone) return res.status(400).json({ error: 'No phone number on record for this staff member' });

    const staffRole = roleNorm === 'manager' ? 'Manager' : 'Operator';
    const staffLang = staff.lang_pref || 'en';
    const msg = staffFollowup(staff, staff.owner_name, staffLang);

    // Send via Meta WhatsApp API
    let waResult = { ok: false, reason: 'WA not configured' };
    const WA_TOKEN    = process.env.WA_TOKEN;
    const WA_PHONE_ID = process.env.WA_PHONE_ID;

    if (WA_TOKEN && WA_PHONE_ID) {
      try {
        const waRes = await fetch(
          `https://graph.facebook.com/v18.0/${WA_PHONE_ID}/messages`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: phone.replace(/\D/g, ''),
              type: 'text',
              text: { body: msg }
            })
          }
        );
        const waData = await waRes.json();
        waResult = waData.messages?.length
          ? { ok: true, meta_msg_id: waData.messages[0].id }
          : { ok: false, reason: waData.error?.message || 'Unknown WA error' };
      } catch (err) {
        waResult = { ok: false, reason: err.message };
      }

      // Log to wa_messages
      try {
        await db.query(`
          CREATE TABLE IF NOT EXISTS wa_messages (
            id TEXT PRIMARY KEY, owner_id TEXT, sender_id TEXT, sender_role TEXT,
            sender_name TEXT, to_phone TEXT, customer_name TEXT, message TEXT,
            category TEXT DEFAULT 'other', status TEXT DEFAULT 'sent',
            meta_msg_id TEXT, error_text TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
          )
        `);
        await db.query(
          `INSERT INTO wa_messages (id,owner_id,sender_id,sender_role,sender_name,to_phone,customer_name,message,category,status,meta_msg_id,error_text)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'other',$9,$10,$11)`,
          [
            'wam_' + Date.now(),
            String(staff.owner_id),
            req.user.id || req.user.email,
            req.user.role,
            req.user.name || req.user.email,
            phone,
            staff.name,
            msg,
            waResult.ok ? 'sent' : 'failed',
            waResult.meta_msg_id || null,
            waResult.ok ? null : waResult.reason,
          ]
        );
      } catch (_) {}
    }

    await db.query(
      `INSERT INTO audit_log (user_email,role,action) VALUES ($1,$2,$3)`,
      [req.user.email, req.user.role,
       `Staff follow-up WA → ${staff.name} (${staffRole}) | ${waResult.ok ? 'sent' : waResult.reason}`]
    );

    res.json({ ok: true, wa: waResult, staffName: staff.name, phone });
  } catch (e) {
    console.error('[staff-followup]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/superadmin/grant-grace/:userId — manually grant 1-month grace
router.post('/grant-grace/:userId', requireAdmin, async (req, res) => {
  try {
    const owner = (await db.query('SELECT * FROM owners WHERE id=$1', [req.params.userId])).rows[0];
    if (!owner) return res.status(404).json({ error: 'Owner not found' });

    const base  = owner.end_date ? new Date(owner.end_date) : new Date();
    const grace = new Date(base);
    grace.setMonth(grace.getMonth() + 1);
    const graceStr = grace.toISOString().slice(0,10);

    await db.query(
      `UPDATE owners SET grace_until=$1, grace_granted_at=NOW(), grace_granted_by=$2,
       grace_wa_day5=FALSE, grace_wa_day15=FALSE, grace_wa_day25=FALSE, updated_at=NOW()
       WHERE id=$3`,
      [graceStr, req.user.email, req.params.userId]
    );

    // Send WA notification about grace grant
    const waResult = await sendRenewalWA(owner);

    await db.query(`INSERT INTO audit_log (user_email,role,action) VALUES ($1,$2,$3)`,
      [req.user.email, req.user.role,
       `Granted 1-month grace to ${owner.name} until ${graceStr} | WA: ${waResult.ok?'sent':waResult.reason}`]);

    res.json({ ok: true, grace_until: graceStr, wa: waResult });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/superadmin/deactivate/:userId — manually deactivate (suspend) account
router.post('/deactivate/:userId', requireAdmin, async (req, res) => {
  try {
    const owner = (await db.query('SELECT * FROM owners WHERE id=$1', [req.params.userId])).rows[0];
    if (!owner) return res.status(404).json({ error: 'Owner not found' });

    await db.query(
      `UPDATE owners SET status='Suspended', updated_at=NOW() WHERE id=$1`,
      [req.params.userId]
    );
    await db.query(`INSERT INTO audit_log (user_email,role,action) VALUES ($1,$2,$3)`,
      [req.user.email, req.user.role, `Manually suspended ${owner.name} (${owner.email})`]);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/superadmin/reactivate/:userId — reactivate a suspended owner
router.post('/reactivate/:userId', requireAdmin, async (req, res) => {
  try {
    await db.query(
      `UPDATE owners SET status='Active', updated_at=NOW() WHERE id=$1`,
      [req.params.userId]
    );
    const owner = (await db.query('SELECT name,email FROM owners WHERE id=$1',[req.params.userId])).rows[0];
    await db.query(`INSERT INTO audit_log (user_email,role,action) VALUES ($1,$2,$3)`,
      [req.user.email, req.user.role, `Reactivated ${owner?.name} (${owner?.email})`]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── STAFF MANAGEMENT ─────────────────────────────────────────────
// GET /api/superadmin/owners/:ownerId/staff
router.get('/owners/:ownerId/staff', requireAdmin, async (req, res) => {
  try {
    const { ownerId } = req.params;
    const [mgrs, ops] = await Promise.all([
      db.query('SELECT id,owner_id,name,email,phone,pump_id,shift,salary,status,created_at FROM managers WHERE owner_id=$1 ORDER BY name', [ownerId]),
      db.query('SELECT id,owner_id,name,email,phone,pump_id,shift,salary,status,created_at FROM operators WHERE owner_id=$1 ORDER BY name', [ownerId]),
    ]);
    res.json({
      managers:  mgrs.rows.map(m => ({ ...m, role: 'manager' })),
      operators: ops.rows.map(o => ({ ...o, role: 'operator' })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/superadmin/staff/:role/:id — edit manager or operator
router.patch('/staff/:role/:id', requireAdmin, async (req, res) => {
  try {
    const { role, id } = req.params;
    const table = role === 'manager' ? 'managers' : 'operators';
    const allowed = ['name', 'email', 'phone', 'shift', 'salary', 'status', 'pump_id'];
    const sets = [], vals = [];
    allowed.forEach(k => {
      if (req.body[k] !== undefined) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); }
    });
    if (!sets.length) return res.json({ ok: true });
    // Also update password if provided
    if (req.body.password) {
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash(req.body.password, 10);
      vals.push(hash); sets.push(`password=$${vals.length}`);
    }
    vals.push(id);
    await db.query(`UPDATE ${table} SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/superadmin/staff/:role/:id
router.delete('/staff/:role/:id', requireAdmin, async (req, res) => {
  try {
    const { role, id } = req.params;
    const table = role === 'manager' ? 'managers' : 'operators';
    await db.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────
// PORTAL STAFF — manage internal company_users (admin/monitor/caller)
// ─────────────────────────────────────────────────────────

// GET /api/superadmin/portal-staff
router.get('/portal-staff', requireAdmin, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, name, email, role, created_at, last_login
       FROM company_users
       ORDER BY created_at DESC`
    );
    res.json(r.rows.map(u => ({
      id:        u.id,
      name:      u.name,
      email:     u.email,
      role:      u.role,
      createdAt: u.created_at,
      lastLogin: u.last_login || null,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/superadmin/portal-staff
router.post('/portal-staff', requireAdmin, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) return res.status(400).json({ error: 'All fields required' });
    const allowed = ['admin', 'monitor', 'caller', 'superadmin'];
    if (!allowed.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    // Check duplicate
    const exists = await db.query('SELECT id FROM company_users WHERE email=$1', [email]);
    if (exists.rows.length) return res.status(409).json({ error: 'Email already exists' });

    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(password, 10);
    const r = await db.query(
      `INSERT INTO company_users (name, email, password, role, created_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING id, name, email, role, created_at`,
      [name, email, hash, role]
    );
    const u = r.rows[0];
    res.json({ id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.created_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/superadmin/portal-staff/:id
router.delete('/portal-staff/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    // Prevent self-delete
    if (req.user && String(req.user.id) === String(id)) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    await db.query('DELETE FROM company_users WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ════════════════════════════════════════════════
// GET /api/superadmin/owner-health — health scores for all owners
// ════════════════════════════════════════════════
router.get('/owner-health', requireAdmin, async (req, res) => {
  try {
    const owners = await db.query(`SELECT id, name, email, phone, plan, status, end_date, city FROM owners WHERE status != 'Deleted' ORDER BY name`);

    const scores = await Promise.all(owners.rows.map(async (o) => {
      const [shifts7d, shifts30d, waCount, staffLogins, creditTxns, nozzleCount, machineTests] = await Promise.all([
        db.query(`SELECT COUNT(*) AS cnt FROM shift_reports WHERE owner_id=$1 AND created_at > NOW()-INTERVAL '7 days'`, [o.id]),
        db.query(`SELECT COUNT(*) AS cnt FROM shift_reports WHERE owner_id=$1 AND created_at > NOW()-INTERVAL '30 days'`, [o.id]),
        db.query(`SELECT COUNT(*) AS cnt FROM wa_messages WHERE owner_id=$1::text AND created_at > NOW()-INTERVAL '30 days'`, [o.id]),
        db.query(`SELECT COUNT(*) AS cnt FROM (
          SELECT MAX(sr.created_at) AS la FROM managers m LEFT JOIN shift_reports sr ON sr.owner_id=m.owner_id WHERE m.owner_id=$1 AND m.status='Active' GROUP BY m.id
          UNION ALL
          SELECT MAX(sr.created_at) AS la FROM operators op LEFT JOIN shift_reports sr ON sr.operator_id=op.id WHERE op.owner_id=$1 AND op.status='Active' GROUP BY op.id
        ) t WHERE la > NOW()-INTERVAL '7 days'`, [o.id]),
        db.query(`SELECT COUNT(*) AS cnt FROM credit_transactions WHERE owner_id=$1 AND created_at > NOW()-INTERVAL '30 days'`, [o.id]).catch(()=>({rows:[{cnt:0}]})),
        db.query(`SELECT COUNT(*) AS cnt FROM nozzles n JOIN pumps p ON p.id=n.pump_id WHERE p.owner_id=$1`, [o.id]).catch(()=>({rows:[{cnt:0}]})),
        db.query(`SELECT COUNT(*) AS cnt FROM machine_tests WHERE owner_id=$1 AND created_at > NOW()-INTERVAL '30 days'`, [o.id]).catch(()=>({rows:[{cnt:0}]})),
      ]);

      const s7   = parseInt(shifts7d.rows[0].cnt);
      const s30  = parseInt(shifts30d.rows[0].cnt);
      const wa   = parseInt(waCount.rows[0].cnt);
      const sl   = parseInt(staffLogins.rows[0].cnt);
      const cr   = parseInt(creditTxns.rows[0].cnt);
      const nz   = parseInt(nozzleCount.rows[0].cnt);
      const mt   = parseInt(machineTests.rows[0].cnt);

      // Score components out of 100
      const shiftScore  = Math.min(40, s30 * 2);       // max 40 — shifts are core usage
      const staffScore  = Math.min(20, sl * 3);         // max 20 — staff active
      const waScore     = Math.min(15, wa * 3);         // max 15 — WA being used
      const creditScore = Math.min(10, cr * 2);         // max 10 — credit entries
      const nozzleScore = Math.min(10, nz >= 1 ? 10 : 0); // max 10 — nozzles configured
      const testScore   = Math.min(5,  mt >= 1 ? 5  : 0);  // max 5  — machine tests
      const total       = Math.round(shiftScore + staffScore + waScore + creditScore + nozzleScore + testScore);

      const risk = total >= 70 ? 'healthy' : total >= 40 ? 'at-risk' : 'critical';

      // Suggestions
      const suggestions = [];
      if (s7 === 0)  suggestions.push('No shifts submitted this week — operator may not be using the app');
      if (sl === 0)  suggestions.push('No staff logins in 7 days — send a follow-up message');
      if (wa === 0)  suggestions.push('WhatsApp not being used — check if WA is configured for this account');
      if (cr === 0)  suggestions.push('No credit entries — remind owner about credit management feature');
      if (nz === 0)  suggestions.push('No nozzles configured — account setup may be incomplete');
      if (mt === 0)  suggestions.push('No machine tests this month — remind about compliance testing');
      if (s30 > 20 && o.plan === 'Basic') suggestions.push('High activity on Basic plan — good candidate for Pro upgrade');

      return {
        id:       String(o.id),
        name:     o.name,
        email:    o.email,
        phone:    o.phone,
        plan:     o.plan,
        status:   o.status,
        end_date: o.end_date,
        city:     o.city,
        score:    total,
        risk,
        metrics: { shifts7d: s7, shifts30d: s30, waMessages: wa, staffActive: sl, creditTxns: cr, nozzles: nz, machineTests: mt },
        suggestions,
      };
    }));

    scores.sort((a, b) => a.score - b.score); // worst first
    res.json({ owners: scores, generated_at: new Date().toISOString() });
  } catch (e) {
    console.error('[owner-health]', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
// GET /api/superadmin/owner-engagement/:ownerId — 30-day drill-down
// ════════════════════════════════════════════════
router.get('/owner-engagement/:ownerId', requireAdmin, async (req, res) => {
  try {
    const { ownerId } = req.params;
    const [owner, shifts, waLogs, staffList, credits, tests] = await Promise.all([
      db.query(`SELECT id,name,email,phone,plan,status,end_date,city,created_at FROM owners WHERE id=$1`, [ownerId]),
      db.query(`SELECT date, total_revenue, shift, operator FROM shift_reports WHERE owner_id=$1 AND created_at > NOW()-INTERVAL '30 days' ORDER BY date DESC LIMIT 60`, [ownerId]),
      db.query(`SELECT DATE(created_at) AS day, COUNT(*) AS cnt, category FROM wa_messages WHERE owner_id=$1::text AND created_at > NOW()-INTERVAL '30 days' GROUP BY day,category ORDER BY day DESC`, [ownerId]),
      db.query(`SELECT 'manager' AS role, name, COALESCE(lang_pref,'en') AS lang_pref, status, (SELECT MAX(sr.created_at) FROM shift_reports sr WHERE sr.owner_id=$1) AS last_active FROM managers WHERE owner_id=$1 AND status='Active'
        UNION ALL SELECT 'operator', name, COALESCE(lang_pref,'en'), status, (SELECT MAX(sr.created_at) FROM shift_reports sr WHERE sr.operator_id=op.id) AS last_active FROM operators op WHERE op.owner_id=$1 AND op.status='Active'`, [ownerId]),
      db.query(`SELECT DATE(created_at) AS day, COUNT(*) AS cnt FROM credit_transactions WHERE owner_id=$1 AND created_at > NOW()-INTERVAL '30 days' GROUP BY day ORDER BY day DESC`, [ownerId]).catch(()=>({rows:[]})),
      db.query(`SELECT date, result FROM machine_tests WHERE owner_id=$1 AND created_at > NOW()-INTERVAL '30 days' ORDER BY date DESC LIMIT 20`, [ownerId]).catch(()=>({rows:[]})),
    ]);

    if (!owner.rows.length) return res.status(404).json({ error: 'Owner not found' });

    // Build 30-day shift calendar
    const shiftDays = new Set(shifts.rows.map(s => s.date?.toString().slice(0,10)));
    const calendar  = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0,10);
      calendar.push({ date: key, hasShift: shiftDays.has(key) });
    }

    res.json({
      owner:    owner.rows[0],
      shifts:   shifts.rows,
      calendar,
      waActivity: waLogs.rows,
      staff:    staffList.rows,
      credits:  credits.rows,
      tests:    tests.rows,
    });
  } catch (e) {
    console.error('[owner-engagement]', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
// POST /api/superadmin/smart-report — AI-powered platform health report
// (never refers to AI/Claude by name in the output)
// ════════════════════════════════════════════════
router.post('/smart-report', requireAdmin, async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'Smart Reports not configured — set ANTHROPIC_API_KEY on backend' });

    // Gather fresh data
    const [owners, shifts7d, waStats, staffStats] = await Promise.all([
      db.query(`SELECT id,name,plan,status,end_date,
        CASE WHEN end_date IS NOT NULL THEN (end_date::date - CURRENT_DATE) ELSE NULL END AS days_left
        FROM owners WHERE status != 'Deleted' ORDER BY end_date ASC`),
      db.query(`SELECT o.name AS owner_name, COUNT(sr.id) AS shift_count
        FROM owners o LEFT JOIN shift_reports sr ON sr.owner_id=o.id AND sr.created_at > NOW()-INTERVAL '7 days'
        GROUP BY o.id, o.name ORDER BY shift_count ASC LIMIT 20`),
      db.query(`SELECT COUNT(*) AS sent, COUNT(*) FILTER (WHERE status='failed') AS failed FROM wa_messages WHERE created_at > NOW()-INTERVAL '7 days'`),
      db.query(`SELECT
        (SELECT COUNT(*) FROM managers WHERE status='Active') AS mgr_count,
        (SELECT COUNT(*) FROM operators WHERE status='Active') AS op_count,
        (SELECT COUNT(*) FROM managers WHERE status='Active' AND id IN (SELECT DISTINCT m.id FROM managers m JOIN shift_reports sr ON sr.owner_id=m.owner_id WHERE sr.created_at > NOW()-INTERVAL '7 days')) AS mgr_active,
        (SELECT COUNT(*) FROM operators op WHERE status='Active' AND id IN (SELECT DISTINCT sr.operator_id FROM shift_reports sr WHERE sr.created_at > NOW()-INTERVAL '7 days' AND sr.operator_id IS NOT NULL)) AS op_active`),
    ]);

    const planPrices = { Basic: 999, Pro: 2499, Business: 5999, Enterprise: 14999 };
    const activeOwners   = owners.rows.filter(o => o.status === 'Active');
    const mrr            = activeOwners.reduce((s, o) => s + (planPrices[o.plan] || 0), 0);
    const expiringIn7    = activeOwners.filter(o => o.days_left !== null && o.days_left <= 7);
    const suspended      = owners.rows.filter(o => o.status === 'Suspended');
    const lowActivity    = shifts7d.rows.filter(r => parseInt(r.shift_count) === 0);
    const wa             = waStats.rows[0];
    const st             = staffStats.rows[0];

    const prompt = `You are a senior business analyst for FuelOS, a petrol pump management SaaS platform in India. Analyze the following weekly platform data and produce a concise, actionable report for the SuperAdmin team. Write in plain English, no markdown headers, no bullet symbols. Use numbered sections. Never mention AI, machine learning, Claude, Anthropic, or any technology vendor names.

PLATFORM DATA (as of ${new Date().toLocaleDateString('en-IN')}):
- Total owners: ${owners.rows.length} (Active: ${activeOwners.length}, Suspended: ${suspended.length})
- Estimated MRR: ₹${mrr.toLocaleString('en-IN')}
- Owners expiring in 7 days: ${expiringIn7.length} (names: ${expiringIn7.map(o=>o.name).join(', ') || 'none'})
- Owners with ZERO shifts this week: ${lowActivity.length} (names: ${lowActivity.slice(0,10).map(o=>o.owner_name).join(', ') || 'none'})
- WhatsApp messages sent (7d): ${wa.sent}, failed: ${wa.failed}
- Active managers: ${st.mgr_active}/${st.mgr_count}, Active operators: ${st.op_active}/${st.op_count}
- Plan breakdown: ${['Basic','Pro','Business','Enterprise'].map(p => `${p}: ${activeOwners.filter(o=>o.plan===p).length}`).join(', ')}

Write a report with exactly these 4 sections:
1. Platform Health Summary (3-4 sentences on overall health)
2. Immediate Actions Required (specific owners to call, with reason)
3. Revenue Risk Analysis (churn risk, at-risk MRR, what to do)
4. Weekly Recommendations (2-3 actionable steps for the team this week)

Keep it concise, direct, and practical. Total length: 200-280 words.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
    });

    if (!aiRes.ok) {
      const err = await aiRes.json().catch(() => ({}));
      return res.status(503).json({ error: 'Smart Report generation failed: ' + (err.error?.message || aiRes.statusText) });
    }

    const aiData = await aiRes.json();
    const report = aiData.content?.[0]?.text || 'Report generation failed.';

    res.json({ report, generated_at: new Date().toISOString(), data_snapshot: { total_owners: owners.rows.length, active: activeOwners.length, mrr, expiring: expiringIn7.length, low_activity: lowActivity.length } });
  } catch (e) {
    console.error('[smart-report]', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
// GET /api/superadmin/upgrade-opportunities — owners who should upgrade
// ════════════════════════════════════════════════
router.get('/upgrade-opportunities', requireAdmin, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT o.id, o.name, o.email, o.phone, o.plan, o.status,
        (SELECT COUNT(*) FROM pumps WHERE owner_id=o.id) AS pump_count,
        (SELECT COUNT(*) FROM nozzles n JOIN pumps p ON p.id=n.pump_id WHERE p.owner_id=o.id) AS nozzle_count,
        (SELECT COUNT(*) FROM managers WHERE owner_id=o.id AND status='Active') AS manager_count,
        (SELECT COUNT(*) FROM operators WHERE owner_id=o.id AND status='Active') AS operator_count,
        (SELECT COUNT(*) FROM shift_reports WHERE owner_id=o.id AND created_at > NOW()-INTERVAL '30 days') AS shifts30d
      FROM owners o WHERE o.status='Active'
    `);

    const planLimits = {
      Basic:      { pumps: 1, nozzles: 4,  staff: 5,  nextPlan: 'Pro',      nextPrice: 2499 },
      Pro:        { pumps: 3, nozzles: 12, staff: 15, nextPlan: 'Business', nextPrice: 5999 },
      Business:   { pumps: 8, nozzles: 40, staff: 50, nextPlan: 'Enterprise', nextPrice: 14999 },
      Enterprise: { pumps: 999, nozzles: 999, staff: 999, nextPlan: null, nextPrice: 0 },
    };

    const opportunities = r.rows.map(o => {
      const lim  = planLimits[o.plan] || planLimits.Basic;
      const pc   = parseInt(o.pump_count);
      const nc   = parseInt(o.nozzle_count);
      const sc   = parseInt(o.manager_count) + parseInt(o.operator_count);
      const s30  = parseInt(o.shifts30d);

      const pumpPct   = lim.pumps   < 999 ? Math.round((pc / lim.pumps)   * 100) : 0;
      const nozzlePct = lim.nozzles < 999 ? Math.round((nc / lim.nozzles) * 100) : 0;
      const staffPct  = lim.staff   < 999 ? Math.round((sc / lim.staff)   * 100) : 0;
      const maxPct    = Math.max(pumpPct, nozzlePct, staffPct);

      if (maxPct < 70 || !lim.nextPlan) return null;

      const reason =
        pumpPct >= 100  ? `Using all ${lim.pumps} pump(s) — at capacity` :
        nozzlePct >= 100? `Using all ${lim.nozzles} nozzles — at capacity` :
        staffPct >= 100 ? `${sc} staff members — at plan limit` :
        pumpPct >= 70   ? `${pc}/${lim.pumps} pumps used (${pumpPct}%)` :
        nozzlePct >= 70 ? `${nc}/${lim.nozzles} nozzles used (${nozzlePct}%)` :
                          `${sc}/${lim.staff} staff used (${staffPct}%)`;

      return {
        id:        String(o.id),
        name:      o.name,
        email:     o.email,
        phone:     o.phone,
        plan:      o.plan,
        nextPlan:  lim.nextPlan,
        nextPrice: lim.nextPrice,
        maxUsage:  maxPct,
        reason,
        shifts30d: s30,
        metrics:   { pumps: pc, nozzles: nc, staff: sc, pumpPct, nozzlePct, staffPct },
      };
    }).filter(Boolean).sort((a, b) => b.maxUsage - a.maxUsage);

    res.json({ opportunities, generated_at: new Date().toISOString() });
  } catch (e) {
    console.error('[upgrade-opportunities]', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
// GET /api/superadmin/renewal-forecast — 90-day renewal pipeline
// ════════════════════════════════════════════════
router.get('/renewal-forecast', requireAdmin, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT id, name, email, phone, plan, status, end_date,
        (end_date::date - CURRENT_DATE) AS days_left,
        (SELECT COUNT(*) FROM shift_reports sr WHERE sr.owner_id=owners.id AND sr.created_at > NOW()-INTERVAL '7 days') AS shifts7d
      FROM owners
      WHERE end_date IS NOT NULL AND end_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 90
        AND status IN ('Active','Grace')
      ORDER BY end_date ASC
    `);

    const planPrices = { Basic: 999, Pro: 2499, Business: 5999, Enterprise: 14999 };

    const rows = r.rows.map(o => ({
      id:        String(o.id),
      name:      o.name,
      email:     o.email,
      phone:     o.phone,
      plan:      o.plan,
      status:    o.status,
      end_date:  o.end_date,
      days_left: parseInt(o.days_left),
      mrr:       planPrices[o.plan] || 0,
      shifts7d:  parseInt(o.shifts7d || 0),
      health:    parseInt(o.shifts7d || 0) >= 3 ? 'active' : parseInt(o.shifts7d || 0) >= 1 ? 'low' : 'inactive',
      week:      parseInt(o.days_left) <= 7 ? 'This Week' : parseInt(o.days_left) <= 14 ? 'Next Week' : parseInt(o.days_left) <= 30 ? 'This Month' : '30-90 Days',
    }));

    const totalForecastMRR = rows.reduce((s, o) => s + o.mrr, 0);
    const atRiskMRR        = rows.filter(o => o.health === 'inactive' && o.days_left <= 30).reduce((s, o) => s + o.mrr, 0);

    res.json({ owners: rows, totalForecastMRR, atRiskMRR, generated_at: new Date().toISOString() });
  } catch (e) {
    console.error('[renewal-forecast]', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
// GET /api/superadmin/feature-adoption — which features each owner uses
// ════════════════════════════════════════════════
router.get('/feature-adoption', requireAdmin, async (req, res) => {
  try {
    const owners = await db.query(`SELECT id, name, plan, status FROM owners WHERE status='Active' ORDER BY name`);

    const featureData = await Promise.all(owners.rows.map(async (o) => {
      const [shifts, credits, expenses, tests, wa, tanks] = await Promise.all([
        db.query(`SELECT COUNT(*) AS cnt FROM shift_reports WHERE owner_id=$1 AND created_at > NOW()-INTERVAL '30 days'`, [o.id]),
        db.query(`SELECT COUNT(*) AS cnt FROM credit_transactions WHERE owner_id=$1 AND created_at > NOW()-INTERVAL '30 days'`, [o.id]).catch(()=>({rows:[{cnt:0}]})),
        db.query(`SELECT COUNT(*) AS cnt FROM expenses WHERE owner_id=$1 AND created_at > NOW()-INTERVAL '30 days'`, [o.id]).catch(()=>({rows:[{cnt:0}]})),
        db.query(`SELECT COUNT(*) AS cnt FROM machine_tests WHERE owner_id=$1 AND created_at > NOW()-INTERVAL '30 days'`, [o.id]).catch(()=>({rows:[{cnt:0}]})),
        db.query(`SELECT COUNT(*) AS cnt FROM wa_messages WHERE owner_id=$1::text AND created_at > NOW()-INTERVAL '30 days'`, [o.id]),
        db.query(`SELECT COUNT(*) AS cnt FROM tanks WHERE owner_id=$1`, [o.id]).catch(()=>({rows:[{cnt:0}]})),
      ]);

      return {
        id:   String(o.id),
        name: o.name,
        plan: o.plan,
        features: {
          shifts:    parseInt(shifts.rows[0].cnt) > 0,
          credit:    parseInt(credits.rows[0].cnt) > 0,
          expenses:  parseInt(expenses.rows[0].cnt) > 0,
          machineTest: parseInt(tests.rows[0].cnt) > 0,
          whatsapp:  parseInt(wa.rows[0].cnt) > 0,
          tanks:     parseInt(tanks.rows[0].cnt) > 0,
        },
        usageCount: [shifts, credits, expenses, tests, wa, tanks].filter(r => parseInt(r.rows[0].cnt) > 0).length,
      };
    }));

    const totalOwners = featureData.length || 1;
    const featureSummary = ['shifts','credit','expenses','machineTest','whatsapp','tanks'].map(f => ({
      feature:   f,
      label:     f === 'shifts' ? 'Shift Reports' : f === 'credit' ? 'Credit Sales' : f === 'expenses' ? 'Expense Tracking' : f === 'machineTest' ? 'Machine Tests' : f === 'whatsapp' ? 'WhatsApp Alerts' : 'Tank Management',
      count:     featureData.filter(o => o.features[f]).length,
      pct:       Math.round((featureData.filter(o => o.features[f]).length / totalOwners) * 100),
    }));

    res.json({ owners: featureData.sort((a,b) => b.usageCount - a.usageCount), featureSummary, generated_at: new Date().toISOString() });
  } catch (e) {
    console.error('[feature-adoption]', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;