// routes/pumps.js
const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/pumps
router.get('/', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const r = await db.query('SELECT * FROM pumps WHERE owner_id=$1 ORDER BY name', [ownerId]);
    res.json(r.rows.map(p => ({ ...p, ownerId: String(p.owner_id), owner_id: String(p.owner_id) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pumps
router.post('/', requireAuth, async (req, res) => {
  try {
    const { id, name, short_name, shortName, city, state, address, gst, status, color } = req.body;
    const ownerId = req.user.owner_id || req.user.id;
    const pumpId = id || 'P' + Date.now();
    await db.query(
      `INSERT INTO pumps (id,owner_id,name,short_name,city,state,address,gst,status,color)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET name=$3,short_name=$4,city=$5,state=$6,address=$7,gst=$8,updated_at=NOW()`,
      [pumpId, ownerId, name, short_name||shortName, city, state, address, gst, status||'Active', color]
    );
    const r = await db.query('SELECT * FROM pumps WHERE id=$1', [pumpId]);
    res.json({ ...r.rows[0], ownerId: String(ownerId) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/pumps/:id
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { name, short_name, shortName, city, state, address, gst, status } = req.body;
    const ownerId = req.user.owner_id || req.user.id;
    await db.query(
      `UPDATE pumps SET name=COALESCE($1,name),short_name=COALESCE($2,short_name),
       city=COALESCE($3,city),state=COALESCE($4,state),address=COALESCE($5,address),
       gst=COALESCE($6,gst),status=COALESCE($7,status),updated_at=NOW()
       WHERE id=$8 AND owner_id=$9`,
      [name, short_name||shortName, city, state, address, gst, status, req.params.id, ownerId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/pumps/:id/nozzles
router.get('/:id/nozzles', requireAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM nozzles WHERE pump_id=$1 ORDER BY id', [req.params.id]);
    res.json(r.rows.map(n => ({ ...n, pumpId: n.pump_id, ownerId: String(n.owner_id) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pumps/:id/nozzles
router.post('/:id/nozzles', requireAuth, async (req, res) => {
  try {
    const { id, fuel, status, operator, open_reading } = req.body;
    const ownerId = req.user.owner_id || req.user.id;
    const openVal = parseFloat(open_reading) || 0;
    await db.query(
      `INSERT INTO nozzles (id,pump_id,owner_id,fuel,status,operator,open,close)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
       ON CONFLICT (id) DO UPDATE SET fuel=$4,status=$5,operator=$6,open=$7`,
      [id, req.params.id, ownerId, fuel, status||'Active', operator||'', openVal]
    );
    res.json({ ok: true, id, open_reading: openVal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/pumps/:id/nozzles/:nozzleId — edit fuel type, operator, or reset opening reading
router.patch('/:id/nozzles/:nozzleId', requireAuth, async (req, res) => {
  try {
    const { fuel, operator, status, open_reading } = req.body;
    const sets = [], vals = [];
    if (fuel        !== undefined) { vals.push(fuel);                    sets.push(`fuel=$${vals.length}`); }
    if (operator    !== undefined) { vals.push(operator);                sets.push(`operator=$${vals.length}`); }
    if (status      !== undefined) { vals.push(status);                  sets.push(`status=$${vals.length}`); }
    if (open_reading!== undefined) { vals.push(parseFloat(open_reading)||0); sets.push(`open=$${vals.length}`); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.nozzleId, req.params.id);
    await db.query(
      `UPDATE nozzles SET ${sets.join(',')} WHERE id=$${vals.length-1} AND pump_id=$${vals.length}`,
      vals
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/pumps/:id/nozzles/:nozzleId
router.delete('/:id/nozzles/:nozzleId', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM nozzles WHERE id=$1 AND pump_id=$2', [req.params.nozzleId, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;