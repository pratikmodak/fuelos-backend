// routes/owners.js — Owner profile + staff CRUD
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');

// GET /api/owners/me
router.get('/me', requireOwner, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM owners WHERE id=$1', [req.user.owner_id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Owner not found' });
    const o = r.rows[0];
    res.json({
      id: String(o.id), email: o.email, name: o.name, phone: o.phone,
      plan: o.plan, billing: o.billing, status: o.status,
      business_name: o.business_name, gst: o.gst, pan: o.pan, address: o.address,
      city: o.city, state: o.state, whatsapp: o.whatsapp, whatsapp_num: o.whatsapp_num,
      start_date: o.start_date, end_date: o.end_date, days_used: o.days_used,
      amount_paid: o.amount_paid, shift_config: o.shift_config || [],
      leaderboard_public: o.leaderboard_public,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/owners/me
router.patch('/me', requireOwner, async (req, res) => {
  try {
    const allowed = ['name','phone','business_name','gst','pan','address','city','state','whatsapp','whatsapp_num','shift_config','leaderboard_public'];
    const sets = [], vals = [];
    allowed.forEach(k => {
      if (req.body[k] !== undefined) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); }
    });
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.user.owner_id);
    await db.query(`UPDATE owners SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${vals.length}`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/owners/staff
router.get('/staff', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const [mgrs, ops] = await Promise.all([
      db.query('SELECT id,owner_id,email,name,phone,pump_id,shift,salary,status,created_at FROM managers WHERE owner_id=$1 ORDER BY name', [ownerId]),
      db.query('SELECT id,owner_id,email,name,phone,pump_id,shift,nozzles,salary,status,points,streak,created_at FROM operators WHERE owner_id=$1 ORDER BY name', [ownerId]),
    ]);
    res.json({
      managers: mgrs.rows.map(m => ({ ...m, id: String(m.id), pump_id: m.pump_id, pumpId: m.pump_id })),
      operators: ops.rows.map(o => ({ ...o, id: String(o.id), pump_id: o.pump_id, pumpId: o.pump_id })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// POST /api/owners/staff — unified create manager or operator
router.post('/staff', requireOwner, async (req, res) => {
  try {
    const { role, name, email, phone, password, shift, pump_id, pumpId, nozzles, salary, status } = req.body;
    const ownerId = req.user.owner_id || req.user.id;
    const resolvedPumpId = pump_id || pumpId || null;

    if (!role) return res.status(400).json({ error: 'role required (manager or operator)' });
    if (!name || !email) return res.status(400).json({ error: 'name and email required' });

    const hash = await bcrypt.hash(password || 'fuelos123', 10);

    if (role === 'manager') {
      const r = await db.query(
        `INSERT INTO managers (owner_id,email,name,phone,password,shift,pump_id,salary,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [ownerId, email, name, phone||null, hash, shift||'Morning', resolvedPumpId, salary||0, status||'Active']
      );
      const m = r.rows[0];
      return res.json({ ...m, id: String(m.id), ownerId: String(m.owner_id), pumpId: m.pump_id });
    }

    if (role === 'operator') {
      const nozzleStr = Array.isArray(nozzles) ? nozzles.join(',') : (nozzles || '');
      const r = await db.query(
        `INSERT INTO operators (owner_id,email,name,phone,password,shift,pump_id,nozzles,salary,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [ownerId, email, name, phone||null, hash, shift||'Morning', resolvedPumpId, nozzleStr, salary||0, status||'Active']
      );
      const o = r.rows[0];
      return res.json({ ...o, id: String(o.id), ownerId: String(o.owner_id), pumpId: o.pump_id });
    }

    res.status(400).json({ error: 'Invalid role. Use manager or operator' });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    console.error('[owners/staff POST]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/owners/managers
router.post('/managers', requireOwner, async (req, res) => {
  try {
    const { name, email, phone, password, shift, pump_id, salary } = req.body;
    const hash = await bcrypt.hash(password || 'fuelos123', 10);
    const r = await db.query(
      `INSERT INTO managers (owner_id,email,name,phone,password,shift,pump_id,salary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.owner_id, email, name, phone, hash, shift, pump_id, salary || 0]
    );
    const m = r.rows[0];
    res.json({ ...m, id: String(m.id) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/owners/operators
router.post('/operators', requireOwner, async (req, res) => {
  try {
    const { name, email, phone, password, shift, pump_id, nozzles, salary } = req.body;
    const hash = await bcrypt.hash(password || 'fuelos123', 10);
    const r = await db.query(
      `INSERT INTO operators (owner_id,email,name,phone,password,shift,pump_id,nozzles,salary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.owner_id, email, name, phone, hash, shift, pump_id, nozzles, salary || 0]
    );
    const o = r.rows[0];
    res.json({ ...o, id: String(o.id) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/owners/operators/:id
router.patch('/operators/:id', requireOwner, async (req, res) => {
  try {
    const { name, phone, shift, pump_id, nozzles, salary, status } = req.body;
    await db.query(
      `UPDATE operators SET name=COALESCE($1,name),phone=COALESCE($2,phone),shift=COALESCE($3,shift),
       pump_id=COALESCE($4,pump_id),nozzles=COALESCE($5,nozzles),salary=COALESCE($6,salary),
       status=COALESCE($7,status),updated_at=NOW() WHERE id=$8 AND owner_id=$9`,
      [name,phone,shift,pump_id,nozzles,salary,status,req.params.id,req.user.owner_id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/owners/operators/:id
router.delete('/operators/:id', requireOwner, async (req, res) => {
  try {
    await db.query('DELETE FROM operators WHERE id=$1 AND owner_id=$2', [req.params.id, req.user.owner_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;