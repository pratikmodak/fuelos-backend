// routes/notifications.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/notifications — get owner's notifications
router.get('/', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const r = await db.query(
      `SELECT * FROM owner_notifications
       WHERE owner_id=$1
       ORDER BY created_at DESC LIMIT 50`,
      [ownerId]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/notifications/read-all — mark all as read
router.patch('/read-all', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    await db.query(
      'UPDATE owner_notifications SET read=TRUE WHERE owner_id=$1',
      [ownerId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/notifications/:id/read — mark one as read
router.patch('/:id/read', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    await db.query(
      'UPDATE owner_notifications SET read=TRUE WHERE id=$1 AND owner_id=$2',
      [req.params.id, ownerId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/notifications/clear — delete all read notifications
router.delete('/clear', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    await db.query(
      'DELETE FROM owner_notifications WHERE owner_id=$1 AND read=TRUE',
      [ownerId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/notifications/price-lock — get owner's price locks
router.get('/price-lock', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const r = await db.query(
      `SELECT pl.*, p.name as pump_name, p.short_name as pump_short_name
       FROM price_locks pl
       JOIN pumps p ON p.id = pl.pump_id
       WHERE pl.owner_id=$1`,
      [ownerId]
    );
    res.json(r.rows.map(row => ({
      id:        row.id,
      pumpId:    row.pump_id,
      pumpName:  row.pump_short_name || row.pump_name,
      petrol:    parseFloat(row.petrol || 0),
      diesel:    parseFloat(row.diesel || 0),
      cng:       parseFloat(row.cng    || 0),
      lockedAt:  row.locked_at,
      lockedDate: row.locked_date,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/price-lock — lock rates for a pump
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

// DELETE /api/notifications/price-lock/:pumpId — unlock rates for a pump
router.delete('/price-lock/:pumpId', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    await db.query(
      'DELETE FROM price_locks WHERE owner_id=$1 AND pump_id=$2',
      [ownerId, req.params.pumpId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;