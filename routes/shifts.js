import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    // For managers/operators their ownerId is the owner they belong to
    let ownerId = req.user.ownerId || req.user.id;
    // If this is a manager/operator, fall back to looking up the pump's owner
    if (req.user.role === 'manager' || req.user.role === 'operator') {
      // Try to find any pump owned by this user's ownerId to confirm
      const ownerExists = await db.get('SELECT id FROM owners WHERE id=?', [ownerId]);
      if (!ownerExists) {
        // ownerId may be the manager's id itself - look up their actual owner via managers table
        const mgr = await db.get('SELECT owner_id FROM managers WHERE id=?', [req.user.id])
               || await db.get('SELECT owner_id FROM operators WHERE id=?', [req.user.id]);
        if (mgr?.owner_id) ownerId = mgr.owner_id;
      }
    }
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
    const { pump_id, date, shift, shift_index, nozzle_readings = [], cash, card, upi, credit_out, manager } = req.body;

    // Resolve the true owner_id — for managers/operators req.user.ownerId should be set,
    // but as a safety net look it up from the pump itself.
    let ownerId = req.user.ownerId;
    if (!ownerId || ownerId === req.user.id && req.user.role !== 'owner') {
      const pump = await db.get('SELECT owner_id FROM pumps WHERE id=?', [pump_id]);
      ownerId = pump?.owner_id || req.user.ownerId || req.user.id;
    }
    // Final FK-safety check — confirm this owner exists
    const ownerExists = await db.get('SELECT id FROM owners WHERE id=?', [ownerId]);
    if (!ownerExists) {
      return res.status(400).json({ error: `Owner not found for ownerId=${ownerId}. Check manager's owner_id assignment.` });
    }
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

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = req.user.ownerId || req.user.id;

    // Verify shift belongs to this user's owner
    const sr = await db.get(
      'SELECT * FROM shift_reports WHERE id=? AND owner_id=?',
      [id, ownerId]
    );
    if (!sr) return res.status(404).json({ error: 'Shift not found or not authorized' });
    if (sr.status === 'Confirmed') {
      return res.status(403).json({ error: 'Cannot undo a confirmed shift. Confirmed shifts are locked by the manager.' });
    }

    await db.tx(async () => {
      // Delete nozzle readings for this shift
      await db.run(
        'DELETE FROM nozzle_readings WHERE pump_id=? AND date=? AND shift=?',
        [sr.pump_id, sr.date, sr.shift]
      );
      // Restore nozzle open readings to pre-shift values (openReading of this shift)
      const readings = await db.all(
        'SELECT nozzle_id, open_reading FROM nozzle_readings WHERE pump_id=? AND date=? AND shift=?',
        [sr.pump_id, sr.date, sr.shift]
      );
      for (const r of readings) {
        await db.run(
          'UPDATE nozzles SET open_reading=? WHERE id=? AND pump_id=?',
          [r.open_reading, r.nozzle_id, sr.pump_id]
        );
      }
      // Delete the shift report
      await db.run('DELETE FROM shift_reports WHERE id=?', [id]);
      // Remove from sales (subtract this shift's contribution)
      await db.run(
        `UPDATE sales SET
          petrol = MAX(0, petrol - ?),
          diesel = MAX(0, diesel - ?),
          cash   = MAX(0, cash   - ?),
          card   = MAX(0, card   - ?),
          upi    = MAX(0, upi    - ?)
        WHERE pump_id=? AND date=?`,
        [sr.petrol||0, sr.diesel||0, sr.cash||0, sr.card||0, sr.upi||0, sr.pump_id, sr.date]
      );
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH confirm a shift — manager confirms amount received, locks the shift
router.patch('/:id/confirm', async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = req.user.ownerId || req.user.id;
    const { cash_received, card_received, upi_received, confirmed_by } = req.body;

    const sr = await db.get(
      'SELECT * FROM shift_reports WHERE id=? AND owner_id=?',
      [id, ownerId]
    );
    if (!sr) return res.status(404).json({ error: 'Shift not found' });
    if (sr.status === 'Confirmed') return res.status(400).json({ error: 'Shift already confirmed' });

    const totalReceived = (cash_received||0) + (card_received||0) + (upi_received||0);

    await db.run(
      `UPDATE shift_reports SET
        status='Confirmed',
        cash=COALESCE(?, cash),
        card=COALESCE(?, card),
        upi=COALESCE(?, upi),
        confirmed_by=?,
        confirmed_at=datetime('now')
       WHERE id=?`,
      [cash_received, card_received, upi_received, confirmed_by||req.user.email, id]
    );

    res.json({ success: true, totalReceived });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE shift — cannot delete Confirmed shifts
// (override the previous DELETE handler logic)

export default router;
