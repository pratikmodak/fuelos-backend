// ── routes/prices.js — Fuel Price Manager
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

const DEFAULTS = { Petrol: 96.72, Diesel: 89.62, CNG: 94.00 };

// GET /api/prices — current rates for owner (global + per-pump)
router.get('/', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const rows = await db.all(
      'SELECT * FROM fuel_rates WHERE owner_id=? ORDER BY updated_at DESC', [ownerId]);
    if (!rows.length) {
      return res.json(
        Object.entries(DEFAULTS).map(([fuel, rate]) => ({
          fuel, rate, pump_id: null,
          effective_date: new Date().toISOString().slice(0, 10)
        }))
      );
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/prices/history — rate change audit trail
router.get('/history', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    res.json(await db.all(
      'SELECT * FROM fuel_rate_log WHERE owner_id=? ORDER BY changed_at DESC LIMIT 50',
      [ownerId]
    ));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/prices — set fuel rates (global or per-pump)
// Body: { rates: [{ fuel, rate, pump_id? }] }
router.post('/', requireRole('owner'), async (req, res) => {
  try {
    const ownerId = req.user.id;
    const { rates } = req.body;
    if (!Array.isArray(rates) || !rates.length)
      return res.status(400).json({ error: 'rates[] required' });

    for (const r of rates) {
      // Get previous rate for audit log
      const existing = await db.get(
        'SELECT rate FROM fuel_rates WHERE owner_id=? AND fuel=? AND pump_id IS ?',
        [ownerId, r.fuel, r.pump_id || null]
      );
      await db.run(
        `INSERT OR REPLACE INTO fuel_rates (id,owner_id,pump_id,fuel,rate,effective_date,updated_at)
         VALUES (?,?,?,?,?,date('now'),datetime('now'))`,
        [uuid(), ownerId, r.pump_id || null, r.fuel, parseFloat(r.rate)]
      );
      await db.run(
        `INSERT INTO fuel_rate_log (id,owner_id,fuel,old_rate,new_rate,pump_id,changed_by,changed_at)
         VALUES (?,?,?,?,?,?,?,datetime('now'))`,
        [uuid(), ownerId, r.fuel, existing?.rate || DEFAULTS[r.fuel],
         r.rate, r.pump_id || null, req.user.email]
      );
    }
    await db.run(`INSERT INTO audit_log VALUES(?,?,?,?,?,datetime('now'))`,
      [uuid(), ownerId, 'Owner',
       `Fuel rates updated: ${rates.map(r => `${r.fuel}=₹${r.rate}`).join(', ')}`, req.ip]);
    res.json({ success: true, updated: rates.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
