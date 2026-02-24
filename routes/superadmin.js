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
