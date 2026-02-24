// ── routes/reports.js — Report Data for PDF Export (Shift, GST, Analytics)
import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

const HSN   = { Petrol: '27101290', Diesel: '27101960', CNG: '27112100' };
const RATES = { Petrol: 96.72, Diesel: 89.62, CNG: 94.00 };

// GET /api/reports/shift/:id — full shift data for PDF
router.get('/shift/:id', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const shift = await db.get(
      'SELECT * FROM shift_reports WHERE id=? AND owner_id=?', [req.params.id, ownerId]);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });

    const readings = await db.all(
      `SELECT nr.*, n.fuel FROM nozzle_readings nr
       LEFT JOIN nozzles n ON nr.nozzle_id=n.id AND nr.pump_id=n.pump_id
       WHERE nr.owner_id=? AND nr.pump_id=? AND nr.date=? AND nr.shift=?`,
      [ownerId, shift.pump_id, shift.date, shift.shift]);

    const pump = await db.get(
      'SELECT * FROM pumps WHERE id=? AND owner_id=?', [shift.pump_id, ownerId]);

    res.json({ shift, readings, pump });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/reports/gst?from=&to=&pump_id= — GST breakdown for PDF
router.get('/gst', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const { from, to, pump_id } = req.query;
    let sql = 'SELECT * FROM sales WHERE owner_id=?';
    const params = [ownerId];
    if (from)    { sql += ' AND date>=?'; params.push(from); }
    if (to)      { sql += ' AND date<=?'; params.push(to); }
    if (pump_id) { sql += ' AND pump_id=?'; params.push(pump_id); }
    const sales = await db.all(sql + ' ORDER BY date', params);

    const totals = { petrol: 0, diesel: 0, cng: 0 };
    sales.forEach(s => {
      totals.petrol += s.petrol || 0;
      totals.diesel += s.diesel || 0;
      totals.cng    += s.cng    || 0;
    });

    const breakdown = Object.entries(totals).map(([fuelLow, gross]) => {
      const fuel = fuelLow.charAt(0).toUpperCase() + fuelLow.slice(1);
      const taxable  = Math.round(gross / 1.18);
      const cgst     = Math.round(taxable * 0.09);
      const qty      = RATES[fuel] ? Math.round(gross / RATES[fuel]) : 0;
      return { fuel, hsn: HSN[fuel] || '', gross, taxable, cgst, sgst: cgst,
               total_gst: cgst * 2, qty };
    });

    const totalGross    = totals.petrol + totals.diesel + totals.cng;
    const totalTaxable  = Math.round(totalGross / 1.18);
    const totalGST      = Math.round(totalTaxable * 0.18);

    res.json({
      sales,
      breakdown,
      summary: { total_gross: totalGross, total_taxable: totalTaxable, total_gst: totalGST,
                 cgst: Math.round(totalGST/2), sgst: Math.round(totalGST/2) },
      period: { from: from || sales[0]?.date || '', to: to || new Date().toISOString().slice(0,10) },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/reports/analytics?days=7&pump_id= — analytics summary for PDF
router.get('/analytics', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const { days = '7', pump_id } = req.query;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - parseInt(days));
    const cutStr = cutoff.toISOString().slice(0, 10);

    let salesSql = 'SELECT * FROM sales WHERE owner_id=? AND date>=?';
    const salesParams = [ownerId, cutStr];
    if (pump_id) { salesSql += ' AND pump_id=?'; salesParams.push(pump_id); }

    const [sales, shifts, pumps] = await Promise.all([
      db.all(salesSql + ' ORDER BY date', salesParams),
      db.all('SELECT * FROM shift_reports WHERE owner_id=? AND date>=? ORDER BY date DESC',
        [ownerId, cutStr]),
      db.all('SELECT * FROM pumps WHERE owner_id=?', [ownerId]),
    ]);

    // Pump-level aggregation
    const pumpStats = pumps.map(p => {
      const ps = sales.filter(s => s.pump_id === p.id);
      const rev = ps.reduce((s, d) => s + d.petrol + d.diesel + d.cng, 0);
      return { ...p, revenue: rev, shifts: shifts.filter(r => r.pump_id === p.id).length };
    });

    res.json({
      sales, shifts, pumps, pump_stats: pumpStats,
      period: { days: parseInt(days), from: cutStr, to: new Date().toISOString().slice(0, 10) },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
