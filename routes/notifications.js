// ── routes/notifications.js — Push Notification Centre
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

// GET /api/notifications — fetch with auto-generated system alerts
router.get('/', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const stored = await db.all(
      'SELECT * FROM notifications WHERE owner_id=? ORDER BY created_at DESC LIMIT 50',
      [ownerId]);

    // Auto-generate from system state (tanks, tests, plan expiry)
    const auto = [];

    // Low stock alerts
    const tanks = await db.all(
      `SELECT t.*, p.short_name, p.name FROM tanks t
       JOIN pumps p ON t.pump_id=p.id
       WHERE t.owner_id=? AND t.stock <= t.alert_at`, [ownerId]);
    for (const t of tanks) {
      auto.push({
        id: `auto-tank-${t.id}`, owner_id: ownerId, type: 'danger',
        icon: '🔴', title: 'Low Stock Alert',
        body: `${t.fuel} at ${t.short_name} — ${t.stock.toLocaleString()}L remaining (below ${t.alert_at.toLocaleString()}L threshold)`,
        read: false, created_at: new Date().toISOString(), auto: true,
      });
    }

    // Machine test failures
    const failTests = await db.all(
      `SELECT mt.*, p.short_name FROM machine_tests mt
       JOIN pumps p ON mt.pump_id=p.id
       WHERE mt.owner_id=? AND mt.result IN ('Fail','Warning')
       AND mt.date >= date('now','-7 days')`, [ownerId]);
    for (const t of failTests) {
      auto.push({
        id: `auto-test-${t.id}`, owner_id: ownerId,
        type: t.result === 'Fail' ? 'danger' : 'warn',
        icon: t.result === 'Fail' ? '🔴' : '🟡',
        title: `Machine Test ${t.result}`,
        body: `Nozzle ${t.nozzle_id} at ${t.short_name} — ${t.result === 'Fail' ? 'calibration required immediately' : 'variance above threshold'}`,
        read: false, created_at: new Date().toISOString(), auto: true,
      });
    }

    // Plan expiry warning
    const owner = await db.get('SELECT * FROM owners WHERE id=?', [ownerId]);
    if (owner?.end_date) {
      const daysLeft = Math.round((new Date(owner.end_date) - new Date()) / 86400000);
      if (daysLeft <= 14 && daysLeft >= 0) {
        auto.push({
          id: `auto-plan-${ownerId}`, owner_id: ownerId,
          type: daysLeft <= 3 ? 'danger' : 'warn',
          icon: daysLeft <= 3 ? '🔴' : '🟡',
          title: 'Plan Expiry Warning',
          body: `Your ${owner.plan} plan expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''} (${owner.end_date}). Renew to avoid disruption.`,
          read: false, created_at: new Date().toISOString(), auto: true,
        });
      }
    }

    // High credit utilization
    const highCredit = await db.all(
      `SELECT * FROM credit_customers WHERE owner_id=? AND outstanding > limit * 0.9`, [ownerId]);
    for (const cc of highCredit) {
      auto.push({
        id: `auto-credit-${cc.id}`, owner_id: ownerId, type: 'warn',
        icon: '🟡', title: 'Credit Limit Warning',
        body: `${cc.name} — ₹${cc.outstanding.toLocaleString()} of ₹${cc.limit.toLocaleString()} limit used (${Math.round(cc.outstanding/cc.limit*100)}%)`,
        read: false, created_at: new Date().toISOString(), auto: true,
      });
    }

    // Combine, dedup by id, sort by time
    const all = [...auto, ...stored].sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at));
    res.json(all);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications — create manual notification (admin use)
router.post('/', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const { type = 'info', title, body, icon } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const id = uuid();
    await db.run(
      `INSERT INTO notifications (id,owner_id,type,icon,title,body,read,created_at)
       VALUES (?,?,?,?,?,?,0,datetime('now'))`,
      [id, ownerId, type, icon || '🔵', title, body || '']
    );
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', async (req, res) => {
  try {
    await db.run('UPDATE notifications SET read=1 WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/notifications/read-all
router.patch('/read-all', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    await db.run('UPDATE notifications SET read=1 WHERE owner_id=?', [ownerId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
