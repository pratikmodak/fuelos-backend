// routes/fuel-prices.js
const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/fuel-prices — all rates + 30-day history
router.get('/', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const r = await db.query(
      `SELECT fp.*, p.name as pump_name FROM fuel_prices fp
       JOIN pumps p ON p.id = fp.pump_id
       WHERE fp.owner_id=$1
       ORDER BY fp.effective_date DESC, fp.pump_id
       LIMIT 200`,
      [ownerId]
    );
    res.json(r.rows.map(fp => ({
      id: fp.id, pumpId: fp.pump_id, pump_id: fp.pump_id,
      pumpName: fp.pump_name, petrol: parseFloat(fp.petrol||0),
      diesel: parseFloat(fp.diesel||0), cng: parseFloat(fp.cng||0),
      effectiveDate: fp.effective_date, date: fp.effective_date,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/fuel-prices/today?pump_id=X
router.get('/today', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { pump_id } = req.query;
    const r = await db.query(
      `SELECT * FROM fuel_prices WHERE owner_id=$1 AND pump_id=$2
       ORDER BY effective_date DESC LIMIT 1`,
      [ownerId, pump_id]
    );
    const fp = r.rows[0];
    res.json(fp ? {
      pumpId: fp.pump_id, petrol: parseFloat(fp.petrol||0),
      diesel: parseFloat(fp.diesel||0), cng: parseFloat(fp.cng||0),
      date: fp.effective_date,
    } : { pumpId: pump_id, petrol: 0, diesel: 0, cng: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/fuel-prices — set rates for one pump
router.post('/', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { pump_id, rates, effective_date } = req.body;
    const date = effective_date || new Date().toISOString().slice(0,10);
    await db.query(
      `INSERT INTO fuel_prices (owner_id,pump_id,petrol,diesel,cng,effective_date)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT DO NOTHING`,
      [ownerId, pump_id, rates.petrol||0, rates.diesel||0, rates.cng||0, date]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/fuel-prices/all-pumps — set same rates for all pumps
router.post('/all-pumps', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { rates, effective_date } = req.body;
    const date = effective_date || new Date().toISOString().slice(0,10);
    const pumps = await db.query('SELECT id FROM pumps WHERE owner_id=$1', [ownerId]);
    for (const p of pumps.rows) {
      await db.query(
        `INSERT INTO fuel_prices (owner_id,pump_id,petrol,diesel,cng,effective_date)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [ownerId, p.id, rates.petrol||0, rates.diesel||0, rates.cng||0, date]
      );
    }
    res.json({ ok: true, pumps: pumps.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
