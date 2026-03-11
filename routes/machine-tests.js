// routes/machine-tests.js
const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logOp } = require('../middleware/audit-middleware');

// GET /api/machine-tests?pump_id=&date=&from_date=&to_date=
router.get('/', requireAuth, async (req, res) => {
  try {
    // owner JWT: { id=ownerId, role='owner', owner_id=undefined }
    // staff JWT: { id=staffId, role='manager'/'operator', owner_id=ownerId }
    const ownerId = req.user.role === 'owner'
      ? req.user.id
      : (req.user.owner_id || req.user.id);
    const { pump_id, date, from_date, to_date, limit = 200 } = req.query;
    const params = [ownerId];
    let where = 'owner_id=$1';
    if (pump_id)   { params.push(pump_id);   where += ` AND pump_id=$${params.length}`; }
    if (date)      { params.push(date);       where += ` AND date=$${params.length}`; }
    if (from_date) { params.push(from_date);  where += ` AND date>=$${params.length}`; }
    if (to_date)   { params.push(to_date);    where += ` AND date<=$${params.length}`; }
    params.push(parseInt(limit));
    const r = await db.query(
      `SELECT * FROM machine_tests WHERE ${where} ORDER BY date DESC, created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json(r.rows);
  } catch (e) {
    console.error('GET machine-tests:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/machine-tests
router.post('/', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.role === 'owner'
      ? req.user.id
      : (req.user.owner_id || req.user.id);
    const {
      id, pumpId, nozzleId, fuel, date, time, shift,
      operator, qty, meterBefore, meterAfter,
      jarReading, variance, result, returnedToTank, notes
    } = req.body;
    const r = await db.query(
      `INSERT INTO machine_tests
        (id, owner_id, pump_id, nozzle_id, fuel, date, shift,
         operator_name, qty, meter_before, meter_after,
         jar_reading, variance, result, returned_to_tank, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO UPDATE SET
         meter_before=EXCLUDED.meter_before, meter_after=EXCLUDED.meter_after,
         jar_reading=EXCLUDED.jar_reading, variance=EXCLUDED.variance,
         result=EXCLUDED.result, notes=EXCLUDED.notes
       RETURNING *`,
      [
        id || `MT-${Date.now()}`, ownerId, pumpId, nozzleId, fuel || 'Petrol',
        date, shift || 'Morning',
        operator || '', parseFloat(qty) || 1,
        parseFloat(meterBefore) || 0, parseFloat(meterAfter) || 0,
        parseFloat(jarReading) || 0, variance ?? null,
        result || 'Pending', returnedToTank !== false, notes || ''
      ]
    );
    await logOp(req, 'machine_test_add', `Nozzle ${nozzleId} · ${result} · ${variance}ml`);
    res.json(r.rows[0]);
  } catch (e) {
    console.error('POST machine-tests:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/machine-tests/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    await db.query('DELETE FROM machine_tests WHERE id=$1 AND owner_id=$2', [req.params.id, ownerId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;