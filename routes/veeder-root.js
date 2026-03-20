// routes/veeder-root.js — Veeder-Root TLS-4B Integration
const router = require('express').Router();
const db     = require('../db');
const crypto = require('crypto');

// Rate limit: max 1 push per minute per owner
const lastPush = new Map();

// Verify HMAC signature from bridge script
function verifySignature(body, sig) {
  const secret = process.env.TLS4B_SECRET;
  if (!secret) return true; // skip if TLS4B_SECRET not set in env
  if (!sig)    return true; // skip if bridge not sending sig yet
  try {
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const a = Buffer.from(sig,      'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return true; } // on any error, allow through
}

// ── POST /api/veeder-root/sync
// Called by local bridge script on Windows PC
router.post('/sync', async (req, res) => {
  try {
    const body    = req.body || {};
    const rawBody = JSON.stringify(body);
    const sig     = req.headers['x-tls4b-sig']   || '';

    // 1. Verify signature (skipped if TLS4B_SECRET not set)
    if (!verifySignature(rawBody, sig)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { owner_id, pump_id, tanks, ts } = body;

    if (!owner_id || !pump_id || !Array.isArray(tanks)) {
      return res.status(400).json({ error: 'Missing owner_id, pump_id or tanks' });
    }

    // 2. Replay protection — reject if timestamp > 2 min old
    if (ts && Date.now() - Number(ts) > 2 * 60 * 1000) {
      return res.status(400).json({ error: 'Request expired (replay protection)' });
    }

    console.log('[TLS4B] Sync request — owner:', owner_id, 'pump:', pump_id, 'tanks:', tanks?.length);

    // 3. Rate limit — max 1 push per minute per owner
    const lastTime = lastPush.get(owner_id) || 0;
    if (Date.now() - lastTime < 60 * 1000) {
      console.log('[TLS4B] Rate limited:', owner_id);
      return res.status(429).json({ error: 'Rate limited — max 1 push/minute' });
    }
    lastPush.set(owner_id, Date.now());

    // 4. Upsert each tank reading
    const synced_at = new Date().toISOString();
    let synced = 0;

    for (const t of tanks) {
      await db.query(`
        INSERT INTO tls4b_readings
          (owner_id, pump_id, tank_no, fuel, volume_l, height_mm, ullage_l, temp_c, water_mm, alarm, synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (owner_id, pump_id, tank_no)
        DO UPDATE SET
          fuel       = EXCLUDED.fuel,
          volume_l   = EXCLUDED.volume_l,
          height_mm  = EXCLUDED.height_mm,
          ullage_l   = EXCLUDED.ullage_l,
          temp_c     = EXCLUDED.temp_c,
          water_mm   = EXCLUDED.water_mm,
          alarm      = EXCLUDED.alarm,
          synced_at  = EXCLUDED.synced_at
      `, [
        String(owner_id), String(pump_id),
        t.tank_no,
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

    console.log(`[TLS4B] ✓ ${owner_id} / ${pump_id} — ${synced} tanks synced`);
    res.json({ ok: true, synced, synced_at });

  } catch (e) {
    console.error('[TLS4B] sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/veeder-root/latest?owner_id=X&pump_id=Y
// Called by dashboard to show live tank levels
router.get('/latest', async (req, res) => {
  try {
    const { owner_id, pump_id } = req.query;
    if (!owner_id) return res.status(400).json({ error: 'Missing owner_id' });

    let query, params;
    if (pump_id) {
      query  = 'SELECT * FROM tls4b_readings WHERE owner_id=$1 AND pump_id=$2 ORDER BY synced_at DESC LIMIT 50';
      params = [owner_id, pump_id];
    } else {
      query  = 'SELECT * FROM tls4b_readings WHERE owner_id=$1 ORDER BY synced_at DESC LIMIT 100';
      params = [owner_id];
    }

    const r = await db.query(query, params);

    // Return latest reading per tank
    const latest = {};
    (r.rows || []).forEach(row => {
      const key = row.pump_id + '_' + row.tank_no;
      if (!latest[key]) latest[key] = row;
    });

    res.json({ tanks: Object.values(latest) });
  } catch (e) {
    console.error('[TLS4B] latest error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── GET /api/veeder-root/debug  (temporary - remove after testing)
router.get('/debug', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM tls4b_readings ORDER BY synced_at DESC LIMIT 20');
    res.json({ count: r.rows.length, rows: r.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;