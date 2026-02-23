import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

router.get('/sales', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const days = parseInt(req.query.days) || 7;
    const pumpId = req.query.pumpId;
    let sql = `SELECT * FROM sales WHERE owner_id=? AND date >= date('now','-'||?||' days')`;
    const params = [ownerId, days];
    if (pumpId) { sql += ' AND pump_id=?'; params.push(pumpId); }
    res.json(await db.all(sql + ' ORDER BY date ASC', params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/summary', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const today = await db.all(`SELECT * FROM sales WHERE owner_id=? AND date=date('now')`, [ownerId]);
    const week  = await db.all(`SELECT * FROM sales WHERE owner_id=? AND date>=date('now','-7 days')`, [ownerId]);
    const sum = arr => ({ petrol: arr.reduce((s,r)=>s+r.petrol,0), diesel: arr.reduce((s,r)=>s+r.diesel,0), cng: arr.reduce((s,r)=>s+r.cng,0) });
    res.json({ today: sum(today), week: sum(week) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
