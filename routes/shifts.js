import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const { pumpId, date, limit = 50 } = req.query;
    let sql = 'SELECT * FROM shift_reports WHERE owner_id=?';
    const params = [ownerId];
    if (pumpId) { sql += ' AND pump_id=?'; params.push(pumpId); }
    if (date)   { sql += ' AND date=?'; params.push(date); }
    sql += ' ORDER BY date DESC, shift_index DESC LIMIT ?';
    params.push(Number(limit));
    res.json(await db.all(sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const { pump_id, date, shift, shift_index, nozzle_readings = [], cash, card, upi, credit_out, manager } = req.body;
    const id = 'SR-' + uuid().slice(0, 8).toUpperCase();
    const totalSales = nozzle_readings.reduce((s, r) => s + (r.revenue || 0), 0);

    await db.tx(async () => {
      await db.run(`INSERT OR REPLACE INTO shift_reports
        (id,owner_id,pump_id,date,shift,shift_index,manager,status,total_sales,cash,card,upi,credit_out,nozzle_count,created_at)
        VALUES (?,?,?,?,?,?,?,'Submitted',?,?,?,?,?,?,datetime('now'))`,
        [id, ownerId, pump_id, date, shift, shift_index, manager, totalSales, cash||0, card||0, upi||0, credit_out||0, nozzle_readings.length]);

      for (const r of nozzle_readings) {
        await db.run(`INSERT OR REPLACE INTO nozzle_readings
          (id,owner_id,pump_id,nozzle_id,fuel,date,shift,shift_index,open_reading,close_reading,test_vol,net_vol,sale_vol,revenue,rate,operator,status,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'Submitted',datetime('now'))`,
          ['NR-'+uuid().slice(0,8), ownerId, pump_id, r.nozzleId, r.fuel, date, shift, shift_index,
           r.openReading, r.closeReading, r.testVol||0, r.netVol||0, r.saleVol||0, r.revenue||0, r.rate||0, r.operator||'']);
        await db.run('UPDATE nozzles SET open_reading=?, close_reading=? WHERE id=? AND pump_id=?',
          [r.closeReading, r.closeReading, r.nozzleId, pump_id]);
      }

      const petrol = nozzle_readings.filter(r=>r.fuel==='Petrol').reduce((s,r)=>s+r.revenue,0);
      const diesel = nozzle_readings.filter(r=>r.fuel==='Diesel').reduce((s,r)=>s+r.revenue,0);
      const cng    = nozzle_readings.filter(r=>r.fuel==='CNG').reduce((s,r)=>s+r.revenue,0);
      await db.run(`INSERT INTO sales (id,owner_id,pump_id,date,petrol,diesel,cng,cash,card,upi,credit_out)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(pump_id,date) DO UPDATE SET
          petrol=petrol+excluded.petrol, diesel=diesel+excluded.diesel, cng=cng+excluded.cng,
          cash=cash+excluded.cash, card=card+excluded.card, upi=upi+excluded.upi`,
        ['S-'+uuid().slice(0,8), ownerId, pump_id, date, petrol, diesel, cng, cash||0, card||0, upi||0, credit_out||0]);
    });

    res.json({ success: true, id, totalSales });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/readings', async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const { pumpId, date, limit = 500 } = req.query;
    let sql = 'SELECT * FROM nozzle_readings WHERE owner_id=?';
    const params = [ownerId];
    if (pumpId) { sql += ' AND pump_id=?'; params.push(pumpId); }
    if (date)   { sql += ' AND date=?'; params.push(date); }
    sql += ' ORDER BY date DESC, shift_index DESC LIMIT ?';
    params.push(Number(limit));
    res.json(await db.all(sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
