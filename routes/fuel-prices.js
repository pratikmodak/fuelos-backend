// ═══════════════════════════════════════════════════════════
// FuelOS — Fuel Price Routes
// Owner sets daily rates per pump per fuel type
// ═══════════════════════════════════════════════════════════
import { Router } from 'express';
import * as db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { v4 as uuid } from 'uuid';

const router = Router();
router.use(requireAuth);

const today = () => new Date().toISOString().slice(0, 10);

// GET /api/fuel-prices — get current rates for all pumps of this owner
// Also returns last 7 days history
router.get('/', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;

    // Latest rate per pump per fuel (most recent effective_date)
    const latest = await db.all(`
      SELECT fp.*
      FROM fuel_prices fp
      INNER JOIN (
        SELECT pump_id, fuel, MAX(effective_date) as max_date
        FROM fuel_prices
        WHERE owner_id = ?
        GROUP BY pump_id, fuel
      ) latest ON fp.pump_id = latest.pump_id
              AND fp.fuel    = latest.fuel
              AND fp.effective_date = latest.max_date
      WHERE fp.owner_id = ?
      ORDER BY fp.pump_id, fp.fuel
    `, [ownerId, ownerId]);

    // History last 30 days
    const history = await db.all(`
      SELECT * FROM fuel_prices
      WHERE owner_id = ? AND effective_date >= date('now', '-30 days')
      ORDER BY effective_date DESC, pump_id, fuel
    `, [ownerId]);

    res.json({ latest, history });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/fuel-prices/today?pump_id=X — get today's rates for a pump (used by manager/operator)
router.get('/today', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const { pump_id } = req.query;

    const rows = await db.all(`
      SELECT fp.*
      FROM fuel_prices fp
      INNER JOIN (
        SELECT fuel, MAX(effective_date) as max_date
        FROM fuel_prices
        WHERE owner_id = ? AND pump_id = ?
        GROUP BY fuel
      ) latest ON fp.fuel = latest.fuel AND fp.effective_date = latest.max_date
      WHERE fp.owner_id = ? AND fp.pump_id = ?
    `, [ownerId, pump_id, ownerId, pump_id]);

    // Build rates map: { Petrol: 96.72, Diesel: 89.62, CNG: 94.00 }
    const rates = {};
    for (const r of rows) rates[r.fuel] = r.rate;

    // Fill missing fuels with national defaults
    const defaults = { Petrol: 96.72, Diesel: 89.62, CNG: 94.00 };
    for (const [fuel, rate] of Object.entries(defaults)) {
      if (!rates[fuel]) rates[fuel] = rate;
    }

    res.json({ rates, date: today(), pump_id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/fuel-prices — set rates for today (or a specific date)
// Body: { pump_id, rates: { Petrol: 96.72, Diesel: 89.62, CNG: 94.00 }, effective_date? }
router.post('/', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const { pump_id, rates, effective_date } = req.body;
    if (!pump_id || !rates) return res.status(400).json({ error: 'pump_id and rates required' });

    const date = effective_date || today();
    const setBy = req.user.email || req.user.name || 'owner';
    const saved = [];

    for (const [fuel, rate] of Object.entries(rates)) {
      if (!rate || isNaN(rate)) continue;
      const id = `FP${uuid().replace(/-/g,'').slice(0,8)}`;
      await db.run(`
        INSERT INTO fuel_prices (id, owner_id, pump_id, fuel, rate, effective_date, set_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(pump_id, fuel, effective_date)
        DO UPDATE SET rate=excluded.rate, set_by=excluded.set_by
      `, [id, ownerId, pump_id, fuel, parseFloat(rate), date, setBy]);
      saved.push({ fuel, rate: parseFloat(rate) });
    }

    res.json({ success: true, saved, date, pump_id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/fuel-prices/all-pumps — set same rates for ALL pumps of this owner
router.post('/all-pumps', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const { rates, effective_date } = req.body;
    if (!rates) return res.status(400).json({ error: 'rates required' });

    const pumps = await db.all('SELECT id FROM pumps WHERE owner_id=?', [ownerId]);
    const date = effective_date || today();
    const setBy = req.user.email || 'owner';
    let count = 0;

    for (const pump of pumps) {
      for (const [fuel, rate] of Object.entries(rates)) {
        if (!rate || isNaN(rate)) continue;
        const id = `FP${uuid().replace(/-/g,'').slice(0,8)}`;
        await db.run(`
          INSERT INTO fuel_prices (id, owner_id, pump_id, fuel, rate, effective_date, set_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(pump_id, fuel, effective_date)
          DO UPDATE SET rate=excluded.rate, set_by=excluded.set_by
        `, [id, ownerId, pump.id, fuel, parseFloat(rate), date, setBy]);
        count++;
      }
    }

    res.json({ success: true, updated: count, date });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;
