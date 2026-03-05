// ═══════════════════════════════════════════════════════════
// FuelOS v3 — Device Integration Routes
// Handles dispenser device auth, heartbeats, and transactions
//
// ENDPOINTS:
//   POST /api/device/register     — Owner registers a new site controller
//   POST /api/device/heartbeat    — Device pings every 30s (nozzle states)
//   POST /api/device/transaction  — Device pushes a completed delivery
//   GET  /api/device/list         — Owner lists all registered devices
//   GET  /api/device/live/:pumpId — Owner/manager polls latest live state
//   POST /api/device/regenerate/:id — Owner regenerates device token
//   DELETE /api/device/:id        — Owner removes device registration
// ═══════════════════════════════════════════════════════════
const router   = require('express').Router();
const db       = require('../db');
const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireOwner } = require('../middleware/auth');
const ws = require('../websocket');

// ── Helpers ─────────────────────────────────────────────────

/** Derive shift name from a timestamp */
function shiftFromTime(ts) {
  const h = new Date(ts).getHours();
  if (h >= 6  && h < 14) return 'Morning';
  if (h >= 14 && h < 22) return 'Afternoon';
  return 'Night';
}

/** Generate a human-readable random token (32 hex chars) */
function makeToken() {
  return require('crypto').randomBytes(16).toString('hex');
}

// ── Device auth middleware ───────────────────────────────────
// Devices send: Authorization: Device <raw_token>
// We look up by device_id (sent in body or header X-Device-Id)
async function requireDevice(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const deviceId   = req.headers['x-device-id'] || req.body?.device_id;

  if (!authHeader.startsWith('Device ') || !deviceId) {
    return res.status(401).json({ error: 'Device auth required: Authorization: Device <token> + X-Device-Id header' });
  }

  const rawToken = authHeader.slice(7);
  try {
    const r = await db.query('SELECT * FROM devices WHERE id=$1 AND status=$2', [deviceId, 'Active']);
    if (!r.rows.length) return res.status(401).json({ error: 'Device not found or inactive' });
    const device = r.rows[0];
    const valid = await bcrypt.compare(rawToken, device.device_token);
    if (!valid) return res.status(401).json({ error: 'Invalid device token' });
    req.device = device;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ════════════════════════════════════════════════════════════
// OWNER: Register a new device
// POST /api/device/register
// Body: { pumpId, name, protocol }
// Returns: { deviceId, rawToken } — rawToken shown ONCE, store it securely
// ════════════════════════════════════════════════════════════
router.post('/register', requireOwner, async (req, res) => {
  try {
    const ownerId = req.user.id;
    const { pumpId, name, protocol = 'generic' } = req.body;
    if (!pumpId) return res.status(400).json({ error: 'pumpId required' });

    // Verify pump belongs to this owner
    const pump = await db.query('SELECT id FROM pumps WHERE id=$1 AND owner_id=$2', [pumpId, ownerId]);
    if (!pump.rows.length) return res.status(403).json({ error: 'Pump not found or access denied' });

    const deviceId  = 'DEV-' + pumpId.slice(0, 8).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
    const rawToken  = makeToken();
    const hashed    = await bcrypt.hash(rawToken, 10);

    await db.query(
      `INSERT INTO devices (id, pump_id, owner_id, device_token, name, protocol, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Active')
       ON CONFLICT (id) DO UPDATE SET device_token=$4, name=$5, protocol=$6, status='Active'`,
      [deviceId, pumpId, ownerId, hashed, name || `Controller – ${pumpId}`, protocol]
    );

    // Return raw token ONCE — owner must save this to the site controller config
    res.json({
      ok: true,
      deviceId,
      rawToken,   // ← SAVE THIS. Cannot be retrieved again.
      note: 'Store rawToken in your site controller .env as FUELOS_DEVICE_TOKEN. It cannot be retrieved after this response.',
      wsUrl: `${process.env.BACKEND_URL || 'wss://your-backend.onrender.com'}/ws`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// DEVICE: Heartbeat — device pings every 30s
// POST /api/device/heartbeat
// Body: { device_id, firmware, nozzle_states: { "N-01": "idle"|"dispensing"|"error" } }
// ════════════════════════════════════════════════════════════
router.post('/heartbeat', requireDevice, async (req, res) => {
  try {
    const { firmware, nozzle_states = {} } = req.body;
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

    // Update device last_seen
    await db.query(
      `UPDATE devices SET last_seen=NOW(), ip_address=$1, firmware=$2 WHERE id=$3`,
      [ip, firmware || req.device.firmware, req.device.id]
    );

    // Log heartbeat (keep 24h only — purge old ones)
    await db.query(
      `INSERT INTO device_heartbeats (device_id, ip_address, firmware, nozzle_states)
       VALUES ($1, $2, $3, $4)`,
      [req.device.id, ip, firmware, JSON.stringify(nozzle_states)]
    );
    await db.query(
      `DELETE FROM device_heartbeats WHERE device_id=$1 AND created_at < NOW() - INTERVAL '24 hours'`,
      [req.device.id]
    );

    // Push live nozzle state to dashboard via WebSocket
    ws.broadcastToPump(req.device.pump_id, req.device.owner_id, {
      type:        'nozzle_states',
      pumpId:      req.device.pump_id,
      deviceId:    req.device.id,
      nozzleStates: nozzle_states,
      ts:          Date.now(),
    });

    res.json({ ok: true, ts: Date.now() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// DEVICE: Push a completed delivery transaction
// POST /api/device/transaction
// Body: {
//   device_id, nozzle_id, fuel, volume_litres, totalizer,
//   rate_per_litre, amount, start_time, end_time, external_txn_id
// }
// ════════════════════════════════════════════════════════════
router.post('/transaction', requireDevice, async (req, res) => {
  try {
    const {
      nozzle_id, fuel, volume_litres, totalizer,
      rate_per_litre, amount, start_time, end_time,
      external_txn_id,
    } = req.body;

    if (!nozzle_id || !volume_litres) {
      return res.status(400).json({ error: 'nozzle_id and volume_litres are required' });
    }

    const endTs   = end_time ? new Date(end_time) : new Date();
    const dateStr = endTs.toISOString().slice(0, 10);
    const shift   = shiftFromTime(endTs);
    const calcAmt = amount ?? (parseFloat(volume_litres) * parseFloat(rate_per_litre || 0));

    // Insert — ON CONFLICT (device_id, external_txn_id) prevents duplicates
    const r = await db.query(
      `INSERT INTO device_transactions
         (device_id, pump_id, owner_id, nozzle_id, external_txn_id,
          fuel, volume_litres, totalizer, rate_per_litre, amount,
          start_time, end_time, date, shift)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (device_id, external_txn_id) DO NOTHING
       RETURNING *`,
      [
        req.device.id, req.device.pump_id, req.device.owner_id, nozzle_id,
        external_txn_id || uuidv4(),
        fuel || 'Petrol',
        parseFloat(volume_litres),
        totalizer ? parseFloat(totalizer) : null,
        rate_per_litre ? parseFloat(rate_per_litre) : null,
        calcAmt,
        start_time ? new Date(start_time) : null,
        endTs, dateStr, shift,
      ]
    );

    if (!r.rows.length) {
      // Duplicate — already processed
      return res.json({ ok: true, duplicate: true });
    }

    const txn = r.rows[0];

    // ── Push live delivery event to dashboard via WebSocket ──
    ws.broadcastToPump(req.device.pump_id, req.device.owner_id, {
      type:         'live_delivery',
      pumpId:       req.device.pump_id,
      deviceId:     req.device.id,
      txnId:        txn.id,
      nozzleId:     nozzle_id,
      fuel:         txn.fuel,
      volumeLitres: parseFloat(txn.volume_litres),
      totalizer:    txn.totalizer ? parseFloat(txn.totalizer) : null,
      amount:       parseFloat(txn.amount),
      shift,
      date:         dateStr,
      ts:           Date.now(),
    });

    // ── Update nozzle close reading in DB if totalizer available ──
    if (totalizer) {
      await db.query(
        `UPDATE nozzles SET close=$1 WHERE id=$2 AND pump_id=$3`,
        [parseFloat(totalizer), nozzle_id, req.device.pump_id]
      ).catch(() => {}); // non-fatal
    }

    console.log(`[Device] Txn ${txn.id} — Pump:${req.device.pump_id} Nozzle:${nozzle_id} ${volume_litres}L ${txn.fuel}`);
    res.json({ ok: true, txnId: txn.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// OWNER: List all registered devices
// GET /api/device/list
// ════════════════════════════════════════════════════════════
router.get('/list', requireOwner, async (req, res) => {
  try {
    const ownerId = req.user.id;
    const r = await db.query(
      `SELECT d.id, d.pump_id, d.name, d.protocol, d.firmware,
              d.ip_address, d.last_seen, d.status, d.created_at,
              p.name as pump_name,
              (SELECT COUNT(*) FROM device_transactions dt WHERE dt.device_id=d.id)::int as total_txns,
              (SELECT COUNT(*) FROM device_transactions dt WHERE dt.device_id=d.id AND dt.date=CURRENT_DATE)::int as txns_today
       FROM devices d
       JOIN pumps p ON p.id = d.pump_id
       WHERE d.owner_id=$1
       ORDER BY d.created_at DESC`,
      [ownerId]
    );
    res.json(r.rows.map(d => ({
      ...d,
      isOnline: d.last_seen ? (Date.now() - new Date(d.last_seen).getTime()) < 90000 : false, // online if seen <90s ago
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// OWNER/MANAGER: Poll latest live dispenser state for a pump
// GET /api/device/live/:pumpId
// Returns: recent transactions + nozzle states from latest heartbeat
// ════════════════════════════════════════════════════════════
router.get('/live/:pumpId', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { pumpId } = req.params;

    // Get device for this pump
    const devR = await db.query(
      `SELECT * FROM devices WHERE pump_id=$1 AND owner_id=$2 AND status='Active' LIMIT 1`,
      [pumpId, ownerId]
    );
    const device = devR.rows[0] || null;

    // Get today's transactions from device
    const txnR = await db.query(
      `SELECT * FROM device_transactions
       WHERE pump_id=$1 AND owner_id=$2 AND date=CURRENT_DATE
       ORDER BY end_time DESC LIMIT 100`,
      [pumpId, ownerId]
    );

    // Get latest heartbeat nozzle states
    const hbR = device ? await db.query(
      `SELECT nozzle_states, created_at FROM device_heartbeats
       WHERE device_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [device.id]
    ) : { rows: [] };

    res.json({
      device: device ? {
        id:          device.id,
        name:        device.name,
        protocol:    device.protocol,
        firmware:    device.firmware,
        lastSeen:    device.last_seen,
        isOnline:    device.last_seen ? (Date.now() - new Date(device.last_seen).getTime()) < 90000 : false,
      } : null,
      nozzleStates: hbR.rows[0]?.nozzle_states || {},
      transactions: txnR.rows.map(t => ({
        id:           t.id,
        nozzleId:     t.nozzle_id,
        fuel:         t.fuel,
        volumeLitres: parseFloat(t.volume_litres),
        totalizer:    t.totalizer ? parseFloat(t.totalizer) : null,
        amount:       parseFloat(t.amount),
        shift:        t.shift,
        endTime:      t.end_time,
        date:         String(t.date).slice(0,10),
      })),
      summary: {
        totalLitres:  txnR.rows.reduce((s, t) => s + parseFloat(t.volume_litres), 0),
        totalRevenue: txnR.rows.reduce((s, t) => s + parseFloat(t.amount), 0),
        txnCount:     txnR.rows.length,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// OWNER: Regenerate device token (if compromised)
// POST /api/device/regenerate/:id
// ════════════════════════════════════════════════════════════
router.post('/regenerate/:id', requireOwner, async (req, res) => {
  try {
    const ownerId = req.user.id;
    const r = await db.query('SELECT * FROM devices WHERE id=$1 AND owner_id=$2', [req.params.id, ownerId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Device not found' });

    const rawToken = makeToken();
    const hashed   = await bcrypt.hash(rawToken, 10);
    await db.query('UPDATE devices SET device_token=$1 WHERE id=$2', [hashed, req.params.id]);

    res.json({ ok: true, rawToken, note: 'Update FUELOS_DEVICE_TOKEN in your site controller config.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// OWNER: Remove a device
// DELETE /api/device/:id
// ════════════════════════════════════════════════════════════
router.delete('/:id', requireOwner, async (req, res) => {
  try {
    const ownerId = req.user.id;
    await db.query('UPDATE devices SET status=$1 WHERE id=$2 AND owner_id=$3', ['Inactive', req.params.id, ownerId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// OWNER: Simulate a delivery (no hardware needed — for testing)
// POST /api/device/simulate
// Auth: owner or manager JWT (no device token needed)
// ════════════════════════════════════════════════════════════
router.post('/simulate', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { pumpId, nozzleId, fuel, volumeLitres, ratePerLitre, amount, startTime, endTime, externalTxnId } = req.body;
    if (!pumpId || !nozzleId || !volumeLitres) {
      return res.status(400).json({ error: 'pumpId, nozzleId, and volumeLitres required' });
    }
    // Verify pump belongs to this owner/manager
    const pumpR = await db.query('SELECT id FROM pumps WHERE id=$1 AND owner_id=$2', [pumpId, ownerId]);
    if (!pumpR.rows.length) return res.status(403).json({ error: 'Pump not found' });

    const endTs   = endTime ? new Date(endTime) : new Date();
    const dateStr = endTs.toISOString().slice(0, 10);
    const shift   = shiftFromTime(endTs);
    const calcAmt = amount ?? (parseFloat(volumeLitres) * parseFloat(ratePerLitre || 0));

    // Find or create a virtual device for this pump
    let deviceR = await db.query(
      `SELECT id FROM devices WHERE pump_id=$1 AND owner_id=$2 AND name LIKE 'Simulator%' LIMIT 1`,
      [pumpId, ownerId]
    );
    let deviceId = deviceR.rows[0]?.id;
    if (!deviceId) {
      deviceId = 'SIM-' + pumpId.slice(0, 8).toUpperCase();
      const fakeToken = await require('bcryptjs').hash('simulator', 10);
      await db.query(
        `INSERT INTO devices (id, pump_id, owner_id, device_token, name, protocol, status)
         VALUES ($1, $2, $3, $4, 'Simulator (No Hardware)', 'simulate', 'Active')
         ON CONFLICT (id) DO NOTHING`,
        [deviceId, pumpId, ownerId, fakeToken]
      );
    }

    const r = await db.query(
      `INSERT INTO device_transactions
         (device_id, pump_id, owner_id, nozzle_id, external_txn_id,
          fuel, volume_litres, rate_per_litre, amount,
          start_time, end_time, date, shift)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (device_id, external_txn_id) DO NOTHING
       RETURNING id`,
      [deviceId, pumpId, ownerId, nozzleId, externalTxnId || uuidv4(),
       fuel || 'Petrol', parseFloat(volumeLitres),
       ratePerLitre ? parseFloat(ratePerLitre) : null, calcAmt,
       startTime ? new Date(startTime) : null, endTs, dateStr, shift]
    );

    // Push live event via WebSocket to anyone watching this pump
    ws.broadcastToPump(pumpId, ownerId, {
      type: 'live_delivery',
      pumpId, deviceId,
      txnId:        r.rows[0]?.id || externalTxnId,
      nozzleId, fuel: fuel || 'Petrol',
      volumeLitres: parseFloat(volumeLitres),
      amount:       calcAmt,
      shift, date:  dateStr,
      simulated:    true,
      ts:           Date.now(),
    });

    res.json({ ok: true, simulated: true, shift, date: dateStr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;