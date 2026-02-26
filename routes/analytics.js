// routes/analytics.js
const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/analytics/sales?days=30&pump_id=X
router.get('/sales', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const days  = parseInt(req.query.days  || 30);
    const pumpId = req.query.pump_id;
    let q = `SELECT date, SUM(petrol) as petrol, SUM(diesel) as diesel,
               SUM(cng) as cng, SUM(total) as total
             FROM sales WHERE owner_id=$1
               AND date >= CURRENT_DATE - INTERVAL '${days} days'`;
    const vals = [ownerId];
    if (pumpId) { vals.push(pumpId); q += ` AND pump_id=$${vals.length}`; }
    q += ' GROUP BY date ORDER BY date ASC';
    const r = await db.query(q, vals);
    res.json(r.rows.map(row => ({
      date:    row.date,
      petrol:  parseFloat(row.petrol  || 0),
      diesel:  parseFloat(row.diesel  || 0),
      cng:     parseFloat(row.cng     || 0),
      total:   parseFloat(row.total   || 0),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/analytics/summary
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const [today, month, pumps, shifts] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(total),0) as revenue FROM sales WHERE owner_id=$1 AND date=CURRENT_DATE`, [ownerId]),
      db.query(`SELECT COALESCE(SUM(total),0) as revenue, COALESCE(SUM(petrol),0) as petrol, COALESCE(SUM(diesel),0) as diesel FROM sales WHERE owner_id=$1 AND date >= date_trunc('month', CURRENT_DATE)`, [ownerId]),
      db.query(`SELECT COUNT(*) FROM pumps WHERE owner_id=$1 AND status='Active'`, [ownerId]),
      db.query(`SELECT COUNT(*) FROM shift_reports WHERE owner_id=$1 AND date=CURRENT_DATE`, [ownerId]),
    ]);
    res.json({
      today_revenue:  parseFloat(today.rows[0].revenue),
      month_revenue:  parseFloat(month.rows[0].revenue),
      month_petrol:   parseFloat(month.rows[0].petrol),
      month_diesel:   parseFloat(month.rows[0].diesel),
      active_pumps:   parseInt(pumps.rows[0].count),
      shifts_today:   parseInt(shifts.rows[0].count),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
