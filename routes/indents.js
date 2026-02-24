// ── routes/indents.js — Tank Refill / Indent Orders
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

// GET /api/indents
router.get('/', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const { status, pumpId } = req.query;
    let sql = 'SELECT * FROM indents WHERE owner_id=?';
    const params = [ownerId];
    if (status) { sql += ' AND status=?'; params.push(status); }
    if (pumpId) { sql += ' AND pump_id=?'; params.push(pumpId); }
    sql += ' ORDER BY ordered_at DESC LIMIT 100';
    res.json(await db.all(sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/indents — create indent order
router.post('/', requireRole('owner'), async (req, res) => {
  try {
    const ownerId = req.user.id;
    const { pump_id, tank_id, fuel, qty, supplier, delivery_date, notes } = req.body;
    if (!pump_id || !fuel || !qty)
      return res.status(400).json({ error: 'pump_id, fuel, qty required' });
    const id = 'IND-' + uuid().slice(0, 8).toUpperCase();
    await db.run(
      `INSERT INTO indents (id,owner_id,pump_id,tank_id,fuel,qty,supplier,delivery_date,notes,status,ordered_at)
       VALUES (?,?,?,?,?,?,?,?,?,'Ordered',date('now'))`,
      [id, ownerId, pump_id, tank_id || null, fuel, parseFloat(qty),
       supplier || 'Primary Supplier', delivery_date || null, notes || null]
    );
    await db.run(`INSERT INTO audit_log VALUES(?,?,?,?,?,datetime('now'))`,
      [uuid(), ownerId, 'Owner', `Indent placed: ${qty}L ${fuel} → ${pump_id}`, req.ip]);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/indents/:id/status — update delivery status
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['Ordered', 'Dispatched', 'Delivered', 'Cancelled'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const indent = await db.get('SELECT * FROM indents WHERE id=?', [req.params.id]);
    if (!indent) return res.status(404).json({ error: 'Indent not found' });
    await db.run('UPDATE indents SET status=? WHERE id=?', [status, req.params.id]);
    // When delivered, add qty to tank stock
    if (status === 'Delivered' && indent.tank_id) {
      await db.run(
        'UPDATE tanks SET stock=MIN(capacity,stock+?), dip=MIN(capacity,dip+?) WHERE id=?',
        [indent.qty, indent.qty, indent.tank_id]
      );
    }
    await db.run(`INSERT INTO audit_log VALUES(?,?,?,?,?,datetime('now'))`,
      [uuid(), indent.owner_id, 'Owner', `Indent ${indent.id} → ${status}`, req.ip]);
    res.json({ success: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/indents/:id
router.delete('/:id', requireRole('owner'), async (req, res) => {
  try {
    const indent = await db.get('SELECT * FROM indents WHERE id=? AND owner_id=?',
      [req.params.id, req.user.id]);
    if (!indent) return res.status(404).json({ error: 'Not found' });
    if (indent.status === 'Delivered')
      return res.status(400).json({ error: 'Cannot delete delivered indent' });
    await db.run('DELETE FROM indents WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
