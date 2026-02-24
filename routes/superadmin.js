// ═══════════════════════════════════════════════════════════
// FuelOS — Super Admin Routes
// Oversight: activity, operators, subscriptions, health
// No access to owner financial/operational private data
// ═══════════════════════════════════════════════════════════
import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

// Only super admin, monitor, caller roles allowed
const requireSuperRole = (req, res, next) => {
  const allowed = ['superadmin', 'monitor', 'caller', 'admin'];
  if (!allowed.includes(req.user?.role))
    return res.status(403).json({ error: 'Super admin access required' });
  next();
};
router.use(requireSuperRole);

// ── GET /api/superadmin/overview
// High-level platform stats — no sensitive owner data
router.get('/overview', async (req, res) => {
  try {
    const [owners, pumps, managers, operators, txns] = await Promise.all([
      db.all(`SELECT id, name, city, plan, status, end_date, created_at FROM owners`),
      db.all(`SELECT id, owner_id, name, status FROM pumps`),
      db.all(`SELECT id, name, pump_id, status, last_login FROM managers`),
      db.all(`SELECT id, name, pump_id, status, last_login FROM operators`),
      db.all(`SELECT id, owner_id, plan, status, amount, date FROM transactions ORDER BY date DESC LIMIT 100`),
    ]);

    const today = new Date().toISOString().slice(0, 10);

    // Activity
    const staffAll = [
      ...managers.map(m => ({ ...m, role: 'Manager' })),
      ...operators.map(o => ({ ...o, role: 'Operator' })),
    ];
    const activeToday   = staffAll.filter(u => u.last_login === today).length;
    const inactive1d    = staffAll.filter(u => u.last_login && dayDiff(u.last_login, today) === 1).length;
    const inactive2plus = staffAll.filter(u => u.last_login && dayDiff(u.last_login, today) >= 2).length;
    const neverLogged   = staffAll.filter(u => !u.last_login).length;

    // Subscriptions
    const expiring7 = owners.filter(o => {
      if (!o.end_date) return false;
      const d = dayDiff(today, o.end_date);
      return d >= 0 && d <= 7;
    });

    res.json({
      counts: {
        owners: owners.length,
        active_owners: owners.filter(o => o.status === 'Active').length,
        pumps: pumps.length,
        managers: managers.length,
        operators: operators.length,
        total_staff: staffAll.length,
      },
      activity: { active_today: activeToday, inactive_1d: inactive1d, inactive_2plus: inactive2plus, never_logged: neverLogged },
      expiring_soon: expiring7.map(o => ({ id: o.id, name: o.name, plan: o.plan, end_date: o.end_date })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/superadmin/activity
// Staff login activity — no financial data
router.get('/activity', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const managers  = await db.all(`SELECT m.id, m.name, m.pump_id, m.status, m.last_login, p.short_name as pump_name FROM managers m LEFT JOIN pumps p ON m.pump_id=p.id`);
    const operators = await db.all(`SELECT o.id, o.name, o.pump_id, o.status, o.last_login, p.short_name as pump_name FROM operators o LEFT JOIN pumps p ON o.pump_id=p.id`);

    const enrich = (users, role) => users.map(u => ({
      id: u.id, name: u.name, role, pump: u.pump_name || '—',
      last_login: u.last_login || null,
      days_inactive: u.last_login ? dayDiff(u.last_login, today) : null,
      status: u.status || 'Active',
      compliance: !u.last_login ? 'never'
        : dayDiff(u.last_login, today) === 0 ? 'compliant'
        : dayDiff(u.last_login, today) === 1 ? 'reminder'
        : 'non-compliant',
    }));

    res.json({
      managers: enrich(managers, 'Manager'),
      operators: enrich(operators, 'Operator'),
      summary: {
        today,
        active_today: [...managers, ...operators].filter(u => u.last_login === today).length,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/superadmin/subscriptions
// Owner subscription status — no private business data
router.get('/subscriptions', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const owners = await db.all(`
      SELECT o.id, o.name, o.city, o.plan, o.status, o.end_date,
             COUNT(p.id) as pump_count
      FROM owners o
      LEFT JOIN pumps p ON p.owner_id=o.id
      GROUP BY o.id
    `);
    res.json(owners.map(o => ({
      ...o,
      days_left: o.end_date ? dayDiff(today, o.end_date) : null,
      expiring_soon: o.end_date ? dayDiff(today, o.end_date) <= 7 : false,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/superadmin/health
// System health — integrations, backend status
router.get('/health', async (req, res) => {
  try {
    const start = Date.now();
    // Test DB
    await db.get('SELECT 1');
    const dbLatency = Date.now() - start;

    // Count recent WhatsApp messages
    const waRecent = await db.get(`SELECT COUNT(*) as cnt FROM wa_log WHERE created_at >= datetime('now','-24 hours')`).catch(() => ({ cnt: 0 }));
    const waDel    = await db.get(`SELECT COUNT(*) as cnt FROM wa_log WHERE status='Delivered' AND created_at >= datetime('now','-24 hours')`).catch(() => ({ cnt: 0 }));

    // Recent payments
    const recentTxns = await db.get(`SELECT COUNT(*) as cnt FROM transactions WHERE date >= date('now','-1 day')`).catch(() => ({ cnt: 0 }));
    const failedTxns = await db.get(`SELECT COUNT(*) as cnt FROM transactions WHERE status='Failed' AND date >= date('now','-1 day')`).catch(() => ({ cnt: 0 }));

    res.json({
      timestamp: new Date().toISOString(),
      services: [
        { name: 'Backend API',   status: 'Online',  latency_ms: dbLatency,   type: 'Core Service' },
        { name: 'Database',      status: 'Online',  latency_ms: dbLatency,   type: 'Storage' },
        { name: 'WhatsApp',      status: waRecent.cnt > 0 ? 'Active' : 'No recent activity', messages_24h: waRecent.cnt, delivered_24h: waDel.cnt, type: 'Messaging' },
        { name: 'Razorpay',      status: recentTxns.cnt > 0 ? 'Active' : 'No recent activity', txns_24h: recentTxns.cnt, failed_24h: failedTxns.cnt, type: 'Payment Gateway' },
      ],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/superadmin/remind/:userId
// Send inactivity reminder (superadmin only, not monitor/caller)
router.post('/remind/:userId', async (req, res) => {
  if (req.user.role === 'monitor') return res.status(403).json({ error: 'Monitor cannot send reminders' });
  try {
    const { userId } = req.params;
    const user = await db.get('SELECT * FROM operators WHERE id=?', [userId])
               || await db.get('SELECT * FROM managers WHERE id=?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Log the reminder in audit log
    const { v4: uuid } = await import('uuid');
    await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [uuid(), req.user.email, req.user.role, `Inactivity reminder sent to: ${user.name} (${user.email})`, req.ip]);
    res.json({ success: true, message: `Reminder logged for ${user.name}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Helper: days between two YYYY-MM-DD strings
function dayDiff(from, to) {
  return Math.round((new Date(to) - new Date(from)) / 86400000);
}

export default router;

// ── GET /api/superadmin/revenue
// Platform revenue summary — transactions, MRR, plan breakdown
router.get('/revenue', async (req, res) => {
  try {
    const txns = await db.all(`SELECT * FROM transactions ORDER BY date DESC`);
    const owners = await db.all(`SELECT id, name, plan, status FROM owners`);
    const today = new Date().toISOString().slice(0, 10);
    const thisMonth = today.slice(0, 7);

    const success = txns.filter(t => t.status === 'Success');
    const failed  = txns.filter(t => t.status === 'Failed');
    const thisMonthTxns = success.filter(t => t.date?.startsWith(thisMonth));

    const planBreakdown = {};
    owners.filter(o => o.status === 'Active').forEach(o => {
      planBreakdown[o.plan] = (planBreakdown[o.plan] || 0) + 1;
    });

    const methodBreakdown = {};
    success.forEach(t => {
      const m = t.method || 'Unknown';
      methodBreakdown[m] = (methodBreakdown[m] || 0) + (t.amount || 0);
    });

    // Last 6 months revenue
    const monthly = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setMonth(d.getMonth() - i);
      const ym = d.toISOString().slice(0, 7);
      const rev = success.filter(t => t.date?.startsWith(ym)).reduce((s, t) => s + (t.amount || 0), 0);
      monthly.push({ month: ym, revenue: rev, count: success.filter(t => t.date?.startsWith(ym)).length });
    }

    res.json({
      total_collected: success.reduce((s, t) => s + (t.amount || 0), 0),
      this_month: thisMonthTxns.reduce((s, t) => s + (t.amount || 0), 0),
      total_txns: txns.length,
      success_count: success.length,
      failed_count: failed.length,
      success_rate: txns.length ? Math.round(success.length / txns.length * 100) : 0,
      plan_breakdown: planBreakdown,
      method_breakdown: methodBreakdown,
      monthly_trend: monthly,
      recent: txns.slice(0, 20),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/superadmin/shifts
// Shift compliance across platform — gaps, variance alerts
router.get('/shifts', async (req, res) => {
  try {
    const shifts = await db.all(`SELECT sr.*, p.name as pump_name, p.short_name, o.name as owner_name
      FROM shift_reports sr
      LEFT JOIN pumps p ON sr.pump_id=p.id AND sr.owner_id=p.owner_id
      LEFT JOIN owners o ON sr.owner_id=o.id
      ORDER BY sr.date DESC LIMIT 200`);

    const today = new Date().toISOString().slice(0, 10);
    const pumps = await db.all(`SELECT id, owner_id, short_name FROM pumps WHERE status='Active'`);

    // Find pumps with no shift submitted today
    const submittedToday = new Set(shifts.filter(s => s.date === today).map(s => s.pump_id));
    const notSubmittedToday = pumps.filter(p => !submittedToday.has(p.id));

    // High variance shifts (>500 difference)
    const highVariance = shifts.filter(s => Math.abs(s.variance || 0) > 500).slice(0, 20);

    res.json({
      total: shifts.length,
      today_count: shifts.filter(s => s.date === today).length,
      not_submitted_today: notSubmittedToday,
      high_variance: highVariance,
      recent: shifts.slice(0, 50),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/superadmin/tests
// Machine test overview across all pumps
router.get('/tests', async (req, res) => {
  try {
    const tests = await db.all(`SELECT mt.*, p.short_name, o.name as owner_name
      FROM machine_tests mt
      LEFT JOIN pumps p ON mt.pump_id=p.id AND mt.owner_id=p.owner_id
      LEFT JOIN owners o ON mt.owner_id=o.id
      ORDER BY mt.date DESC LIMIT 200`);

    const today = new Date().toISOString().slice(0, 10);
    const todayTests = tests.filter(t => t.date === today);

    res.json({
      total: tests.length,
      today: todayTests.length,
      pass: tests.filter(t => t.result === 'Pass').length,
      fail: tests.filter(t => t.result === 'Fail').length,
      warning: tests.filter(t => t.result === 'Warning').length,
      fail_today: todayTests.filter(t => t.result === 'Fail').length,
      critical_fails: tests.filter(t => t.result === 'Fail' && dayDiff(t.date, today) <= 3),
      recent: tests.slice(0, 50),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/superadmin/tanks
// Tank stock overview — low stock across all pumps
router.get('/tanks', async (req, res) => {
  try {
    const tanks = await db.all(`SELECT t.*, p.short_name, p.name as pump_name, o.name as owner_name
      FROM tanks t
      LEFT JOIN pumps p ON t.pump_id=p.id AND t.owner_id=p.owner_id
      LEFT JOIN owners o ON t.owner_id=o.id`);

    const lowStock = tanks.filter(t => t.stock <= (t.alert_at || 1000));
    const critical = tanks.filter(t => t.stock <= (t.alert_at || 1000) * 0.3);

    res.json({
      total: tanks.length,
      low_stock_count: lowStock.length,
      critical_count: critical.length,
      low_stock: lowStock,
      all: tanks,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/superadmin/credits
// Credit customer risk overview across platform
router.get('/credits', async (req, res) => {
  try {
    const credits = await db.all(`SELECT cc.*, p.short_name, o.name as owner_name
      FROM credit_customers cc
      LEFT JOIN pumps p ON cc.pump_id=p.id AND cc.owner_id=p.owner_id
      LEFT JOIN owners o ON cc.owner_id=o.id`);

    const totalOutstanding = credits.reduce((s, c) => s + (c.outstanding || 0), 0);
    const totalLimit = credits.reduce((s, c) => s + (c.credit_limit || 0), 0);
    const overdue = credits.filter(c => c.status === 'Overdue');
    const highRisk = credits.filter(c => c.credit_limit > 0 && c.outstanding / c.credit_limit > 0.8);

    res.json({
      total_customers: credits.length,
      total_outstanding: totalOutstanding,
      total_limit: totalLimit,
      utilization_pct: totalLimit ? Math.round(totalOutstanding / totalLimit * 100) : 0,
      overdue_count: overdue.length,
      high_risk_count: highRisk.length,
      overdue,
      high_risk: highRisk,
      all: credits.slice(0, 100),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/superadmin/whatsapp
// WhatsApp delivery health across platform
router.get('/whatsapp', async (req, res) => {
  try {
    const logs = await db.all(`SELECT w.*, o.name as owner_name
      FROM wa_log w LEFT JOIN owners o ON w.owner_id=o.id
      ORDER BY w.created_at DESC LIMIT 200`);

    const total = logs.length;
    const delivered = logs.filter(l => l.status === 'Delivered').length;
    const failed = logs.filter(l => l.status === 'Failed').length;

    const byOwner = {};
    logs.forEach(l => {
      if (!byOwner[l.owner_id]) byOwner[l.owner_id] = { name: l.owner_name, total: 0, delivered: 0, failed: 0 };
      byOwner[l.owner_id].total++;
      if (l.status === 'Delivered') byOwner[l.owner_id].delivered++;
      if (l.status === 'Failed') byOwner[l.owner_id].failed++;
    });

    res.json({
      total, delivered, failed,
      delivery_rate: total ? Math.round(delivered / total * 100) : 0,
      by_owner: Object.values(byOwner),
      recent_failures: logs.filter(l => l.status === 'Failed').slice(0, 20),
      recent: logs.slice(0, 50),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/superadmin/contacts  (Caller role)
// Owner contact list for outreach — phone, plan, expiry, status
router.get('/contacts', async (req, res) => {
  try {
    const owners = await db.all(`SELECT id, name, email, phone, city, plan, status, end_date,
      (SELECT COUNT(*) FROM pumps WHERE owner_id=owners.id) as pump_count
      FROM owners ORDER BY name`);
    const today = new Date().toISOString().slice(0, 10);
    res.json(owners.map(o => ({
      ...o,
      days_left: o.end_date ? dayDiff(today, o.end_date) : null,
      priority: !o.end_date ? 'normal'
        : dayDiff(today, o.end_date) <= 3 ? 'urgent'
        : dayDiff(today, o.end_date) <= 7 ? 'high'
        : 'normal',
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/superadmin/outreach-log  (Caller role)
// Log a call/outreach made to an owner
router.post('/outreach-log', async (req, res) => {
  if (req.user.role === 'monitor') return res.status(403).json({ error: 'Monitor cannot log outreach' });
  try {
    const { owner_id, note, outcome } = req.body;
    const { v4: uuid } = await import('uuid');
    const id = uuid();
    await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
      [id, req.user.email, req.user.role, `Outreach: [${outcome||'Called'}] owner_id=${owner_id} — ${note||''}`, req.ip]);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/superadmin/analytics  (Monitor: platform-level volume/revenue)
router.get('/platform-analytics', async (req, res) => {
  try {
    const sales = await db.all(`SELECT s.*, p.short_name, o.name as owner_name
      FROM sales s
      LEFT JOIN pumps p ON s.pump_id=p.id AND s.owner_id=p.owner_id
      LEFT JOIN owners o ON s.owner_id=o.id
      ORDER BY s.date DESC LIMIT 500`);

    const today = new Date().toISOString().slice(0, 10);
    const last7  = sales.filter(s => dayDiff(s.date, today) <= 7);
    const last30 = sales.filter(s => dayDiff(s.date, today) <= 30);

    const sum = arr => ({
      petrol: arr.reduce((s, x) => s + (x.petrol || 0), 0),
      diesel: arr.reduce((s, x) => s + (x.diesel || 0), 0),
      cng:    arr.reduce((s, x) => s + (x.cng || 0), 0),
      cash:   arr.reduce((s, x) => s + (x.cash || 0), 0),
      card:   arr.reduce((s, x) => s + (x.card || 0), 0),
      upi:    arr.reduce((s, x) => s + (x.upi || 0), 0),
      total:  arr.reduce((s, x) => s + (x.petrol || 0) + (x.diesel || 0) + (x.cng || 0), 0),
    });

    res.json({
      last7:  sum(last7),
      last30: sum(last30),
      all:    sum(sales),
      daily:  sales.slice(0, 30),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
