// FuelOS — Analytics Routes
import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

// GET /api/analytics/sales?days=7&pumpId=P1
router.get('/sales', (req, res) => {
  const ownerId = req.user.ownerId || req.user.id;
  const days = parseInt(req.query.days) || 7;
  const pumpId = req.query.pumpId;
  let sql = `SELECT * FROM sales WHERE owner_id=? AND date >= date('now','-'||?||' days')`;
  const params = [ownerId, days];
  if (pumpId) { sql += ' AND pump_id=?'; params.push(pumpId); }
  sql += ' ORDER BY date ASC';
  res.json(db.all(sql, params));
});

// GET /api/analytics/summary
router.get('/summary', (req, res) => {
  const ownerId = req.user.ownerId || req.user.id;
  const today   = db.all(`SELECT * FROM sales WHERE owner_id=? AND date=date('now')`, [ownerId]);
  const week    = db.all(`SELECT * FROM sales WHERE owner_id=? AND date>=date('now','-7 days')`, [ownerId]);
  const sum = arr => ({ petrol: arr.reduce((s,r)=>s+r.petrol,0), diesel: arr.reduce((s,r)=>s+r.diesel,0), cng: arr.reduce((s,r)=>s+r.cng,0) });
  res.json({ today: sum(today), week: sum(week) });
});

export default router;
