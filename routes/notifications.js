// routes/notifications.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Upsert a notification — avoid duplicates for same owner+type+key on same day
async function upsertNotif(ownerId, type, title, body, data = {}, key = null) {
  const dedupeKey = key || `${type}_${JSON.stringify(data).slice(0,80)}`;
  const existing = await db.query(
    `SELECT id FROM owner_notifications
     WHERE owner_id=$1 AND type=$2 AND data->>'dedup_key'=$3
       AND DATE(created_at) = CURRENT_DATE`,
    [ownerId, type, dedupeKey]
  );
  if (existing.rows.length > 0) return;
  await db.query(
    `INSERT INTO owner_notifications (owner_id, type, title, body, data)
     VALUES ($1,$2,$3,$4,$5)`,
    [ownerId, type, title, body, JSON.stringify({ ...data, dedup_key: dedupeKey })]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-GENERATE smart notifications for owner
// ─────────────────────────────────────────────────────────────────────────────
async function generateOwnerNotifs(ownerId) {
  try {
    // Single combined query — all data in one round trip
    const [summaryRes] = await Promise.all([
      db.query(`
        SELECT
          o.name, o.end_date, o.plan, o.status,
          (SELECT COUNT(*) FROM shift_reports sr WHERE sr.owner_id=o.id AND DATE(sr.created_at)=CURRENT_DATE) AS shifts_today,
          (SELECT COUNT(*) FROM operators op WHERE op.owner_id=o.id AND op.status='Active'
             AND (SELECT MAX(created_at) FROM shift_reports WHERE operator_id=op.id) < NOW() - INTERVAL '2 days') AS inactive_ops,
          (SELECT COUNT(*) FROM credit_customers cc WHERE cc.owner_id=o.id AND cc.outstanding>0 AND cc.status='Active') AS credit_count,
          (SELECT COALESCE(SUM(outstanding),0) FROM credit_customers cc WHERE cc.owner_id=o.id AND cc.outstanding>0 AND cc.status='Active') AS credit_total,
          (SELECT name FROM credit_customers cc WHERE cc.owner_id=o.id AND cc.outstanding>0 AND cc.status='Active' ORDER BY outstanding DESC LIMIT 1) AS top_credit_name
        FROM owners o WHERE o.id=$1
      `, [ownerId]),
    ]);

    const row = summaryRes.rows[0];
    if (!row) return;

    const upserts = [];

    // Subscription
    if (row.end_date) {
      const daysLeft = Math.ceil((new Date(row.end_date) - new Date()) / 86400000);
      if (daysLeft <= 7 && daysLeft >= 0 && row.status !== 'Suspended')
        upserts.push(upsertNotif(ownerId, 'subscription_expiring',
          `⚠️ Subscription expiring in ${daysLeft} day${daysLeft===1?'':'s'}`,
          `Your ${row.plan} plan expires on ${new Date(row.end_date).toLocaleDateString('en-IN')}. Renew now.`,
          { days_left: daysLeft }, `sub_expiry_${daysLeft}`));
      if (row.status === 'Grace')
        upserts.push(upsertNotif(ownerId, 'subscription_grace', '🔴 Account in Grace Period',
          'Your subscription has expired. Please renew to restore full access.', {}, 'sub_grace_today'));
    }

    // Staff inactive
    const inactiveCount = parseInt(row.inactive_ops || 0);
    if (inactiveCount > 0)
      upserts.push(upsertNotif(ownerId, 'staff_inactive',
        `👥 ${inactiveCount} operator${inactiveCount>1?'s':''} not active in 2+ days`,
        `${inactiveCount} operator${inactiveCount>1?'s have':' has'} not submitted shifts recently.`,
        { count: inactiveCount }, `staff_inactive_${inactiveCount}`));

    // Shifts today
    const shiftCount = parseInt(row.shifts_today || 0);
    if (shiftCount > 0)
      upserts.push(upsertNotif(ownerId, 'shifts_submitted',
        `✅ ${shiftCount} shift${shiftCount>1?'s':''} submitted today`,
        `Your operators submitted ${shiftCount} shift report${shiftCount>1?'s':''} today.`,
        { count: shiftCount }, `shifts_today_${shiftCount}`));

    // Credit outstanding
    const creditCount = parseInt(row.credit_count || 0);
    const creditTotal = parseFloat(row.credit_total || 0);
    if (creditCount > 0 && creditTotal > 0)
      upserts.push(upsertNotif(ownerId, 'credit_outstanding',
        `🤝 ₹${Math.round(creditTotal).toLocaleString('en-IN')} outstanding from ${creditCount} credit customer${creditCount>1?'s':''}`,
        `${row.top_credit_name || 'A customer'} has the highest balance. Tap Credits to collect.`,
        { total: creditTotal, count: creditCount }, `credit_outstanding_${Math.round(creditTotal)}`));

    // No shifts today after 10am
    if (new Date().getHours() >= 10 && shiftCount === 0)
      upserts.push(upsertNotif(ownerId, 'no_shift_today',
        '⚠️ No shifts submitted today yet',
        "It's past 10 AM and no shifts have been submitted. Check if your operators are active.",
        {}, 'no_shift_today'));

    // All upserts in parallel
    await Promise.all(upserts);

  } catch (e) {
    console.error('[generateOwnerNotifs]', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-GENERATE notifications for manager or operator (ephemeral — in memory)
// ─────────────────────────────────────────────────────────────────────────────
async function generateStaffNotifs(userId, role) {
  const table = role === 'manager' ? 'managers' : 'operators';
  try {
    const staffRes = await db.query(
      `SELECT s.*, o.name AS owner_name, o.end_date, o.status AS owner_status,
              p.name AS pump_name
       FROM ${table} s
       LEFT JOIN owners o ON o.id = s.owner_id
       LEFT JOIN pumps  p ON p.id = s.pump_id
       WHERE s.id = $1`, [userId]
    );
    const staff = staffRes.rows[0];
    if (!staff) return [];

    const notifs = [];

    // 1. Nozzle assignments for today
    const assignRes = await db.query(
      `SELECT nozzle_ids, shift FROM daily_nozzle_assignments
       WHERE operator_id=$1 AND date=CURRENT_DATE
       ORDER BY created_at DESC LIMIT 3`, [String(userId)]
    );
    assignRes.rows.forEach(a => {
      notifs.push({
        id:    `assign_${userId}_${a.shift}`,
        type:  'nozzle_assigned',
        title: `⛽ Nozzles assigned — ${a.shift} shift`,
        body:  `Your nozzles for today: ${a.nozzle_ids}. Open your shift to begin.`,
        read:  false, ts: Date.now(), icon: '⛽', level: 'info',
      });
    });

    // 2. Shift reminder — no shift submitted today
    const hour = new Date().getHours();
    if (hour >= 7) {
      const q = role === 'operator'
        ? await db.query(`SELECT COUNT(*) AS cnt FROM shift_reports WHERE operator_id=$1 AND DATE(created_at)=CURRENT_DATE`, [String(userId)])
        : await db.query(`SELECT COUNT(*) AS cnt FROM shift_reports WHERE owner_id=$1 AND DATE(created_at)=CURRENT_DATE`, [String(staff.owner_id)]);
      if (parseInt(q.rows[0]?.cnt || 0) === 0) {
        notifs.push({
          id:    `no_shift_${userId}_today`,
          type:  'shift_reminder',
          title: '📋 No shift submitted today yet',
          body:  'Remember to open and submit your shift report for today.',
          read:  false, ts: Date.now() - 1000, icon: '📋', level: 'warning',
        });
      }
    }

    // 3. Low tank stock alert
    try {
      const tankRes = await db.query(
        `SELECT t.fuel, t.current_level, t.capacity
         FROM tanks t
         JOIN pumps p ON p.id = t.pump_id
         WHERE p.owner_id = $1 AND t.pump_id = $2
           AND t.capacity > 0 AND (t.current_level::float / t.capacity::float) < 0.20`,
        [String(staff.owner_id), String(staff.pump_id)]
      );
      tankRes.rows.forEach(t => {
        const pct = Math.round((parseFloat(t.current_level) / parseFloat(t.capacity)) * 100);
        notifs.push({
          id:    `tank_low_${staff.pump_id}_${t.fuel}`,
          type:  'tank_low',
          title: `🛢 Low stock — ${t.fuel} at ${pct}%`,
          body:  `${t.fuel} tank is at ${parseFloat(t.current_level).toFixed(0)}L / ${parseFloat(t.capacity).toFixed(0)}L. Arrange refill soon.`,
          read:  false, ts: Date.now() - 500, icon: '🛢', level: 'warning',
        });
      });
    } catch (_) {}

    // 4. Owner account warning
    if (staff.owner_status === 'Grace' || staff.owner_status === 'Suspended') {
      notifs.push({
        id:    `owner_status_${staff.owner_id}`,
        type:  'owner_status',
        title: staff.owner_status === 'Suspended' ? '🔴 Account suspended' : '⚠️ Account in grace period',
        body:  `${staff.owner_name}'s subscription needs renewal. Some features may be limited.`,
        read:  false, ts: Date.now() - 2000, icon: '⚠️', level: 'warning',
      });
    }

    return notifs;
  } catch (e) {
    console.error('[generateStaffNotifs]', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/notifications
router.get('/', requireAuth, async (req, res) => {
  try {
    const role    = req.user.role || 'owner';
    const userId  = req.user.id   || req.user.owner_id;
    const ownerId = req.user.owner_id || req.user.id;

    if (role === 'owner') {
      await generateOwnerNotifs(ownerId);
      const r = await db.query(
        `SELECT * FROM owner_notifications
         WHERE owner_id=$1
         ORDER BY read ASC, created_at DESC LIMIT 50`, [ownerId]
      );
      return res.json(r.rows.map(n => ({
        id:      n.id,
        ownerId: n.owner_id,
        type:    n.type,
        title:   n.title,
        body:    n.body,
        data:    n.data || {},
        read:    n.read,
        ts:      new Date(n.created_at).getTime(),
        icon:    n.type === 'price_change' ? '💰'
               : n.type === 'subscription_expiring' || n.type === 'subscription_grace' ? '⚠️'
               : n.type === 'staff_inactive' ? '👥'
               : n.type === 'shifts_submitted' ? '✅'
               : n.type === 'credit_outstanding' ? '🤝'
               : n.type === 'no_shift_today' ? '⚠️'
               : '🔔',
        level:   n.type === 'subscription_grace' || n.type === 'no_shift_today' ? 'warning'
               : n.type === 'shifts_submitted' ? 'success'
               : 'info',
      })));
    }

    // Manager / Operator
    const roleNorm    = role === 'manager' ? 'manager' : 'operator';
    const staffNotifs = await generateStaffNotifs(userId, roleNorm);
    return res.json(staffNotifs);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/notifications/read-all
router.patch('/read-all', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    await db.query('UPDATE owner_notifications SET read=TRUE WHERE owner_id=$1', [ownerId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    // Ephemeral staff notifs (non-UUID ids) have no DB row
    if (!req.params.id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-/)) return res.json({ ok: true });
    await db.query(
      'UPDATE owner_notifications SET read=TRUE WHERE id=$1 AND owner_id=$2',
      [req.params.id, ownerId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/notifications/clear
router.delete('/clear', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    await db.query('DELETE FROM owner_notifications WHERE owner_id=$1 AND read=TRUE', [ownerId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Price lock routes ────────────────────────────────────────────────────────

router.get('/price-lock', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const r = await db.query(
      `SELECT pl.*, p.name as pump_name, p.short_name as pump_short_name
       FROM price_locks pl JOIN pumps p ON p.id = pl.pump_id
       WHERE pl.owner_id=$1`, [ownerId]
    );
    res.json(r.rows.map(row => ({
      id:         row.id,
      pumpId:     row.pump_id,
      pumpName:   row.pump_short_name || row.pump_name,
      petrol:     parseFloat(row.petrol || 0),
      diesel:     parseFloat(row.diesel || 0),
      cng:        parseFloat(row.cng    || 0),
      lockedAt:   row.locked_at,
      lockedDate: row.locked_date,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/price-lock', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { pump_id, petrol, diesel, cng } = req.body;
    await db.query(
      `INSERT INTO price_locks (owner_id, pump_id, petrol, diesel, cng, locked_at, locked_date)
       VALUES ($1,$2,$3,$4,$5,NOW(),CURRENT_DATE)
       ON CONFLICT (owner_id, pump_id)
       DO UPDATE SET petrol=$3, diesel=$4, cng=$5, locked_at=NOW(), locked_date=CURRENT_DATE`,
      [ownerId, pump_id, petrol||0, diesel||0, cng||0]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/price-lock/:pumpId', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    await db.query('DELETE FROM price_locks WHERE owner_id=$1 AND pump_id=$2', [ownerId, req.params.pumpId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;