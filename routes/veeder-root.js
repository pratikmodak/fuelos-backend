// routes/veeder-root.js — Veeder-Root TLS-4B Integration
const router = require('express').Router();
const db     = require('../db');

// ── POST /api/veeder-root/sync
// Called by local bridge script on Windows PC every 5 minutes
router.post('/sync', async (req, res) => {
  try {
    const { owner_id, pump_id, tanks } = req.body || {};

    console.log('[TLS4B] /sync called — owner:', owner_id, 'pump:', pump_id, 'tanks:', tanks?.length);

    if (!owner_id || !pump_id || !Array.isArray(tanks) || tanks.length === 0) {
      console.log('[TLS4B] Missing fields:', { owner_id, pump_id, tanks });
      return res.status(400).json({ error: 'Missing owner_id, pump_id or tanks' });
    }

    const synced_at = new Date().toISOString();
    let synced = 0;

    for (const t of tanks) {
      console.log('[TLS4B] Inserting tank:', t.tank_no, t.fuel, t.volume_l + 'L');
      await db.query(`
        INSERT INTO tls4b_readings
          (owner_id, pump_id, tank_no, fuel, volume_l, height_mm, ullage_l, temp_c, water_mm, alarm, synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (owner_id, pump_id, tank_no)
        DO UPDATE SET
          fuel      = EXCLUDED.fuel,
          volume_l  = EXCLUDED.volume_l,
          height_mm = EXCLUDED.height_mm,
          ullage_l  = EXCLUDED.ullage_l,
          temp_c    = EXCLUDED.temp_c,
          water_mm  = EXCLUDED.water_mm,
          alarm     = EXCLUDED.alarm,
          synced_at = EXCLUDED.synced_at
      `, [
        String(owner_id),
        String(pump_id),
        parseInt(t.tank_no),
        t.fuel      || 'Petrol',
        parseFloat(t.volume_l)  || 0,
        parseFloat(t.height_mm) || 0,
        parseFloat(t.ullage_l)  || 0,
        parseFloat(t.temp_c)    || 0,
        parseFloat(t.water_mm)  || 0,
        t.alarm || null,
        synced_at,
      ]);
      synced++;
    }

    console.log('[TLS4B] ✓ Saved', synced, 'tanks for owner', owner_id);
    res.json({ ok: true, synced, synced_at });

  } catch (e) {
    console.error('[TLS4B] sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/veeder-root/latest?owner_id=X&pump_id=Y
// Called by dashboard
router.get('/latest', async (req, res) => {
  try {
    const { owner_id, pump_id } = req.query;
    if (!owner_id) return res.status(400).json({ error: 'Missing owner_id' });

    let r;
    if (pump_id) {
      r = await db.query(
        'SELECT * FROM tls4b_readings WHERE owner_id=$1 AND pump_id=$2 ORDER BY synced_at DESC LIMIT 50',
        [owner_id, pump_id]
      );
    } else {
      r = await db.query(
        'SELECT * FROM tls4b_readings WHERE owner_id=$1 ORDER BY synced_at DESC LIMIT 100',
        [owner_id]
      );
    }

    // Return only latest reading per tank
    const latest = {};
    (r.rows || []).forEach(row => {
      const key = row.pump_id + '_' + row.tank_no;
      if (!latest[key]) latest[key] = row;
    });

    const tanks = Object.values(latest);
    console.log('[TLS4B] /latest — owner:', owner_id, 'found:', tanks.length, 'tanks');
    res.json({ tanks });

  } catch (e) {
    console.error('[TLS4B] latest error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/veeder-root/debug
router.get('/debug', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM tls4b_readings ORDER BY synced_at DESC LIMIT 20');
    res.json({ count: r.rows.length, rows: r.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;