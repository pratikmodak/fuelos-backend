// routes/shifts.js
const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/shifts
router.get('/', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { limit = 200, pump_id, from, to } = req.query;
    let q = 'SELECT * FROM shift_reports WHERE owner_id=$1';
    const vals = [ownerId];
    if (pump_id) { vals.push(pump_id); q += ` AND pump_id=$${vals.length}`; }
    if (from)    { vals.push(from);    q += ` AND date >= $${vals.length}`; }
    if (to)      { vals.push(to);      q += ` AND date <= $${vals.length}`; }
    q += ` ORDER BY date DESC, created_at DESC LIMIT $${vals.length + 1}`;
    vals.push(parseInt(limit));
    const r = await db.query(q, vals);
    res.json(r.rows.map(s => ({
      ...s, id: String(s.id),
      ownerId: String(s.owner_id), owner_id: String(s.owner_id),
      pumpId: s.pump_id, operatorId: String(s.operator_id||''),
      nozzleReadings: s.nozzle_readings || [],
      totalRevenue: parseFloat(s.total_revenue||0),
      petrolVol: parseFloat(s.petrol_vol||0),
      dieselVol: parseFloat(s.diesel_vol||0),
      cngVol: parseFloat(s.cng_vol||0),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/shifts/readings
router.get('/readings', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { limit = 500, pump_id, from, to } = req.query;
    let q = 'SELECT * FROM nozzle_readings WHERE owner_id=$1';
    const vals = [ownerId];
    if (pump_id) { vals.push(pump_id); q += ` AND pump_id=$${vals.length}`; }
    if (from)    { vals.push(from);    q += ` AND date >= $${vals.length}`; }
    if (to)      { vals.push(to);      q += ` AND date <= $${vals.length}`; }
    q += ` ORDER BY date DESC LIMIT $${vals.length + 1}`;
    vals.push(parseInt(limit));
    const r = await db.query(q, vals);
    res.json(r.rows.map(nr => ({
      ...nr,
      pumpId: nr.pump_id, nozzleId: nr.nozzle_id,
      openReading: parseFloat(nr.open_reading||0),
      closeReading: parseFloat(nr.close_reading||0),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/shifts — submit shift report
router.post('/', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const s = req.body;
    const totalRevenue = (s.cash||0) + (s.upi||0) + (s.card||0) + (s.credit||0);

    // Upsert shift
    await db.query(
      `INSERT INTO shift_reports
         (id,owner_id,pump_id,operator_id,operator,shift,date,nozzle_readings,
          cash,upi,card,credit,total_revenue,petrol_vol,diesel_vol,cng_vol,status,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (id) DO UPDATE SET
         cash=$9,upi=$10,card=$11,credit=$12,total_revenue=$13,
         petrol_vol=$14,diesel_vol=$15,cng_vol=$16,status=$17,note=$18,
         nozzle_readings=$8`,
      [
        s.id, ownerId, s.pumpId||s.pump_id, s.operatorId||s.operator_id||null,
        s.operator, s.shift, s.date, JSON.stringify(s.nozzleReadings||s.nozzle_readings||[]),
        s.cash||0, s.upi||0, s.card||0, s.credit||0, totalRevenue,
        s.petrolVol||s.petrol_vol||0, s.dieselVol||s.diesel_vol||0, s.cngVol||s.cng_vol||0,
        s.status||'Submitted', s.note||null
      ]
    );

    // Upsert sales aggregate for the day
    if (s.pumpId || s.pump_id) {
      await db.query(
        `INSERT INTO sales (owner_id,pump_id,date,petrol,diesel,cng,total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (owner_id,pump_id,date) DO UPDATE SET
           petrol=sales.petrol+EXCLUDED.petrol,
           diesel=sales.diesel+EXCLUDED.diesel,
           cng=sales.cng+EXCLUDED.cng,
           total=sales.total+EXCLUDED.total`,
        [ownerId, s.pumpId||s.pump_id, s.date,
         s.petrolVol||0, s.dieselVol||0, s.cngVol||0, totalRevenue]
      );
    }

    // Save individual nozzle readings
    for (const nr of (s.nozzleReadings || [])) {
      await db.query(
        `INSERT INTO nozzle_readings
           (shift_id,pump_id,owner_id,nozzle_id,fuel,operator,date,
            open_reading,close_reading,volume,rate,revenue)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT DO NOTHING`,
        [
          s.id, s.pumpId||s.pump_id, ownerId,
          nr.nozzleId||nr.nozzle_id||nr.id, nr.fuel, nr.operator||s.operator,
          s.date, nr.open||nr.openReading||0, nr.close||nr.closeReading||0,
          nr.volume||0, nr.rate||0, nr.revenue||0
        ]
      ).catch(() => {}); // Ignore duplicate errors for readings
    }

    res.json({ ok: true, id: s.id });
  } catch (e) {
    console.error('[shifts/post]', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/shifts/:id — undo shift
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    await db.query('DELETE FROM shift_reports WHERE id=$1 AND owner_id=$2', [req.params.id, ownerId]);
    await db.query('DELETE FROM nozzle_readings WHERE shift_id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/shifts/:id/confirm
router.patch('/:id/confirm', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    await db.query(
      `UPDATE shift_reports SET status='Confirmed', note=$1 WHERE id=$2 AND owner_id=$3`,
      [req.body.note, req.params.id, ownerId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
