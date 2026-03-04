// routes/shifts.js
const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/shifts
router.get('/', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { limit = 200, pump_id, from, to } = req.query;
    let q = 'SELECT * FROM shift_reports WHERE owner_id=$1';
    const vals = [ownerId];
    if (pump_id) { vals.push(pump_id); q += ` AND pump_id=$${vals.length}`; }
    if (from)    { vals.push(from);    q += ` AND date >= $${vals.length}`; }
    if (to)      { vals.push(to);      q += ` AND date <= $${vals.length}`; }
    q += ` ORDER BY date DESC, created_at DESC LIMIT $${vals.length + 1}`;
    vals.push(parseInt(limit));
    const r = await db.query(q, vals);
    res.json(r.rows.map(s => ({
      ...s, id: String(s.id),
      ownerId: String(s.owner_id), owner_id: String(s.owner_id),
      pumpId: String(s.pump_id||''), pump_id: String(s.pump_id||''), operatorId: String(s.operator_id||''),
      nozzleReadings: s.nozzle_readings || [],
      totalRevenue: parseFloat(s.total_revenue||0),
      petrolVol:    parseFloat(s.petrol_vol||0),
      dieselVol:    parseFloat(s.diesel_vol||0),
      cngVol:       parseFloat(s.cng_vol||0),
      date:         String(s.date||'').slice(0,10), // normalize DATE → YYYY-MM-DD
      totalSales:   parseFloat(s.total_revenue||0),
      cash:         parseFloat(s.cash||0),
      upi:          parseFloat(s.upi||0),
      card:         parseFloat(s.card||0),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/shifts/readings
router.get('/readings', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { limit = 500, pump_id, from, to } = req.query;
    let q = 'SELECT * FROM nozzle_readings WHERE owner_id=$1';
    const vals = [ownerId];
    if (pump_id) { vals.push(pump_id); q += ` AND pump_id=$${vals.length}`; }
    if (from)    { vals.push(from);    q += ` AND date >= $${vals.length}`; }
    if (to)      { vals.push(to);      q += ` AND date <= $${vals.length}`; }
    q += ` ORDER BY date DESC LIMIT $${vals.length + 1}`;
    vals.push(parseInt(limit));
    const r = await db.query(q, vals);
    res.json(r.rows.map(nr => ({
      ...nr,
      pumpId:       nr.pump_id,
      nozzleId:     nr.nozzle_id,
      openReading:  parseFloat(nr.open_reading||0),
      closeReading: parseFloat(nr.close_reading||0),
      date:         String(nr.date||'').slice(0,10),
      shift:        nr.shift || '',
      status:       nr.status || 'Submitted',
      shiftIndex:   nr.shift_index ?? nr.shiftIndex ?? 0,
      saleVol:      parseFloat(nr.volume||0),
      revenue:      parseFloat(nr.revenue||0),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const wa = require('../services/whatsapp');

// POST /api/shifts — submit shift report
router.post('/', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const s = req.body;
    const totalRevenue = (s.cash||0) + (s.upi||0) + (s.card||0) + (s.credit||0);

    // Ensure shift column exists (added after initial schema)
    await db.query(`ALTER TABLE nozzle_readings ADD COLUMN IF NOT EXISTS shift TEXT`).catch(()=>{});

    // Ensure shift_started_at column exists (added after initial schema)
    await db.query(`ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS shift_started_at TIMESTAMPTZ`).catch(()=>{});

    // Upsert shift
    await db.query(
      `INSERT INTO shift_reports
         (id,owner_id,pump_id,operator_id,operator,shift,date,nozzle_readings,
          cash,upi,card,credit,total_revenue,petrol_vol,diesel_vol,cng_vol,status,note,shift_started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (id) DO UPDATE SET
         cash=$9,upi=$10,card=$11,credit=$12,total_revenue=$13,
         petrol_vol=$14,diesel_vol=$15,cng_vol=$16,status=$17,note=$18,
         nozzle_readings=$8,
         shift_started_at=COALESCE(shift_reports.shift_started_at, EXCLUDED.shift_started_at)`,
      [
        s.id, ownerId, s.pumpId||s.pump_id, s.operatorId||s.operator_id||null,
        s.operator, s.shift, s.date, JSON.stringify(s.nozzleReadings||s.nozzle_readings||[]),
        s.cash||0, s.upi||0, s.card||0, s.credit||0, totalRevenue,
        s.petrolVol||s.petrol_vol||0, s.dieselVol||s.diesel_vol||0, s.cngVol||s.cng_vol||0,
        s.status||'Submitted', s.note||null,
        s.startedAt || null,
      ]
    );

    // Upsert sales aggregate for the day
    if (s.pumpId || s.pump_id) {
      await db.query(
        `INSERT INTO sales (owner_id,pump_id,date,petrol,diesel,cng,total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (owner_id,pump_id,date) DO UPDATE SET
           petrol=sales.petrol+EXCLUDED.petrol,
           diesel=sales.diesel+EXCLUDED.diesel,
           cng=sales.cng+EXCLUDED.cng,
           total=sales.total+EXCLUDED.total`,
        [ownerId, s.pumpId||s.pump_id, s.date,
         s.petrolVol||0, s.dieselVol||0, s.cngVol||0, totalRevenue]
      );
    }

    // Save individual nozzle readings
    for (const nr of (s.nozzleReadings || [])) {
      await db.query(
        `INSERT INTO nozzle_readings
           (shift_id,pump_id,owner_id,nozzle_id,fuel,operator,date,shift,shift_index,
            open_reading,close_reading,volume,rate,revenue)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT DO NOTHING`,
        [
          s.id, s.pumpId||s.pump_id, ownerId,
          nr.nozzleId||nr.nozzle_id, nr.fuel, nr.operator||s.operator,
          s.date, s.shift, nr.shiftIndex??nr.shift_index??0,
          nr.openReading??nr.open_reading??0,
          nr.closeReading??nr.close_reading??0,
          nr.saleVol??nr.volume??0, nr.rate||0, nr.revenue||0
        ]
      ).catch(e => console.error('[nozzle_readings insert]', e.message));
    }

    res.json({ ok: true, id: s.id });

    // ── Non-blocking WhatsApp notification to owner
    setImmediate(async () => {
      try {
        // Get owner's WhatsApp number
        const ownerRow = await db.query(
          'SELECT whatsapp_num, whatsapp, name FROM owners WHERE id=$1', [ownerId]
        );
        const ownerPhone = ownerRow.rows[0]?.whatsapp_num;
        console.log('[shifts/wa-notify] owner:', ownerId, 'phone:', ownerPhone||'(none)');
        if (!ownerPhone) {
          console.log('[shifts/wa-notify] No whatsapp_num for owner', ownerId, '— skipping');
          return;
        }

        // Get pump name
        const pumpRow = await db.query('SELECT name FROM pumps WHERE id=$1', [s.pumpId||s.pump_id]);
        const pumpName = pumpRow.rows[0]?.name || 'Pump';

        await wa.notifyShiftSubmitted(ownerPhone, {
          operator:     s.operator,
          shift:        s.shift,
          pumpName,
          date:         s.date,
          totalRevenue: totalRevenue,
          cash:         s.cash||0,
          upi:          s.upi||0,
          card:         s.card||0,
          petrolVol:    s.petrolVol||s.petrol_vol||0,
          dieselVol:    s.dieselVol||s.diesel_vol||0,
        });
      } catch (e) {
        console.error('[shifts/wa-notify] ERROR:', e.message, e.stack?.split('\n')[1]);
      }
    });
  } catch (e) {
    console.error('[shifts/post]', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/shifts/:id — undo shift
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    await db.query('DELETE FROM shift_reports WHERE id=$1 AND owner_id=$2', [req.params.id, ownerId]);
    await db.query('DELETE FROM nozzle_readings WHERE shift_id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/shifts/:id/confirm
router.patch('/:id/confirm', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { note, cash_received, card_received, upi_received, confirmed_by } = req.body;
    await db.query(
      `UPDATE shift_reports
       SET status='Confirmed', note=$1,
           cash_received=$2, card_received=$3, upi_received=$4,
           confirmed_by=$5, confirmed_at=NOW()
       WHERE id=$6 AND owner_id=$7`,
      [note||'', parseFloat(cash_received)||0, parseFloat(card_received)||0,
       parseFloat(upi_received)||0, confirmed_by||'', req.params.id, ownerId]
    );
    res.json({ ok: true });

    // Non-blocking WA notification to owner on shift confirm
    setImmediate(async () => {
      try {
        const shiftRow = await db.query(
          `SELECT sr.operator, sr.shift, sr.total_revenue, p.name as pump_name,
                  o.whatsapp_num
           FROM shift_reports sr
           JOIN pumps p ON p.id = sr.pump_id
           JOIN owners o ON o.id = sr.owner_id
           WHERE sr.id = $1`, [req.params.id]
        );
        const s = shiftRow.rows[0];
        if (!s?.whatsapp_num) return;
        await wa.notifyShiftConfirmed(s.whatsapp_num, {
          pumpName:    s.pump_name,
          operator:    s.operator,
          shift:       s.shift,
          confirmedBy: req.body.confirmed_by || 'Manager',
          amount:      s.total_revenue,
        });
      } catch (e) { console.warn('[shifts/confirm/wa]', e.message); }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════
// DAILY NOZZLE ASSIGNMENTS
// ════════════════════════════════════════════════

// POST /api/shifts/assign-nozzles — manager assigns nozzles to an operator for date+shift
router.post('/assign-nozzles', requireAuth, async (req, res) => {
  try {
    const { operator_id, pump_id, date, shift, nozzle_ids } = req.body;
    if (!operator_id || !pump_id || !date || !shift)
      return res.status(400).json({ error: 'operator_id, pump_id, date, shift required' });
    const ownerId = req.user.owner_id || req.user.id;
    const nozzleStr = Array.isArray(nozzle_ids) ? nozzle_ids.join(',') : (nozzle_ids || '');
    const r = await db.query(
      `INSERT INTO daily_nozzle_assignments
         (owner_id, pump_id, operator_id, date, shift, nozzle_ids, assigned_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (pump_id, operator_id, date, shift)
       DO UPDATE SET nozzle_ids=$6, assigned_by=$7, updated_at=NOW()
       RETURNING *`,
      [ownerId, pump_id, operator_id, date, shift, nozzleStr, req.user.email]
    );
    res.json({ ok: true, assignment: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/shifts/assignments?pump_id=&date= — manager gets all assignments for a pump/date
router.get('/assignments', requireAuth, async (req, res) => {
  try {
    const { pump_id, date } = req.query;
    const ownerId = req.user.owner_id || req.user.id;
    const where = ['owner_id=$1'];
    const vals  = [ownerId];
    if (pump_id) { vals.push(pump_id);  where.push(`pump_id=$${vals.length}`); }
    if (date)    { vals.push(date);     where.push(`date=$${vals.length}`); }
    const r = await db.query(
      `SELECT * FROM daily_nozzle_assignments WHERE ${where.join(' AND ')} ORDER BY date DESC, shift`,
      vals
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/shifts/my-nozzles?date=&shift= — operator gets their assigned nozzles
router.get('/my-nozzles', requireAuth, async (req, res) => {
  try {
    const { date, shift } = req.query;
    const operatorId = req.user.id;
    const today = date || new Date().toISOString().split('T')[0];
    // Get ALL shifts for today so operator can see across shifts
    const r = await db.query(
      `SELECT * FROM daily_nozzle_assignments
       WHERE operator_id=$1 AND date=$2
       ORDER BY shift`,
      [operatorId, today]
    );
    if (r.rows.length === 0) return res.json({ nozzle_ids: [], assignments: [] });
    // If shift specified, filter; else merge all
    const relevant = shift ? r.rows.filter(a => a.shift === shift) : r.rows;
    const allNozzleIds = [...new Set(
      relevant.flatMap(a => a.nozzle_ids ? a.nozzle_ids.split(',').filter(Boolean) : [])
    )];
    res.json({ nozzle_ids: allNozzleIds, assignments: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Attendance ───────────────────────────────────────────────────────────────

// Auto-create attendance table
const ensureAttendanceTable = async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS daily_attendance (
    id           SERIAL PRIMARY KEY,
    owner_id     UUID NOT NULL,
    pump_id      TEXT NOT NULL,
    operator_id  UUID NOT NULL,
    date         DATE NOT NULL,
    status       TEXT NOT NULL DEFAULT 'present',
    shift        TEXT,
    note         TEXT,
    marked_by    TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(operator_id, date, shift)
  )`);
};

// POST /api/shifts/attendance  — save/update attendance for a day
router.post('/attendance', requireAuth, async (req, res) => {
  try {
    await ensureAttendanceTable();
    const ownerId = req.user.owner_id || req.user.id;
    const { records } = req.body;
    // records = [{ operator_id, pump_id, date, shift, status, note }]
    if (!Array.isArray(records) || records.length === 0)
      return res.status(400).json({ error: 'records array required' });
    for (const rec of records) {
      await db.query(
        `INSERT INTO daily_attendance (owner_id,pump_id,operator_id,date,shift,status,note,marked_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (operator_id,date,shift)
         DO UPDATE SET status=$6, note=$7, marked_by=$8, updated_at=NOW()`,
        [ownerId, rec.pump_id, rec.operator_id, rec.date, rec.shift||'All',
         rec.status||'present', rec.note||null, req.user.email||req.user.name||null]
      );
    }
    res.json({ ok: true, saved: records.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/shifts/attendance?pump_id=&date=&month=YYYY-MM  — load attendance records
router.get('/attendance', requireAuth, async (req, res) => {
  try {
    await ensureAttendanceTable();
    const ownerId = req.user.owner_id || req.user.id;
    const { pump_id, date, month } = req.query;
    const where = ['owner_id=$1'];
    const vals  = [ownerId];
    if (pump_id) { vals.push(pump_id); where.push(`pump_id=$${vals.length}`); }
    if (date)    { vals.push(date);    where.push(`date=$${vals.length}`); }
    if (month)   { vals.push(month + '-01'); vals.push(month + '-31');
                   where.push(`date >= $${vals.length-1} AND date <= $${vals.length}`); }
    const r = await db.query(
      `SELECT * FROM daily_attendance WHERE ${where.join(' AND ')} ORDER BY date DESC, operator_id`,
      vals
    );
    res.json(r.rows.map(a => ({
      id: a.id, operatorId: String(a.operator_id), pumpId: String(a.pump_id),
      date: String(a.date).slice(0,10), shift: a.shift, status: a.status,
      note: a.note, markedBy: a.marked_by, createdAt: a.created_at,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// GET /api/shifts/attendance-report?pump_id=&month=YYYY-MM
// Rich report joining shift_reports + nozzle assignments
router.get('/attendance-report', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { pump_id, month } = req.query;
    if (!month) return res.status(400).json({ error: 'month required (YYYY-MM)' });

    const monthStart = month + '-01';
    // last day of month
    const [yr, mo] = month.split('-').map(Number);
    const monthEnd = new Date(yr, mo, 0).toISOString().slice(0,10);

    const where = ['sr.owner_id=$1', 'sr.date >= $2', 'sr.date <= $3'];
    const vals  = [ownerId, monthStart, monthEnd];
    if (pump_id) { vals.push(pump_id); where.push(`sr.pump_id=$${vals.length}`); }

    // Shift start times (India standard pump shifts)
    const shiftStart = { Morning: '06:00', Afternoon: '14:00', Night: '22:00' };

    const r = await db.query(`
      SELECT sr.*,
             dna.nozzle_ids AS assigned_nozzles,
             MIN(nr.created_at) AS first_reading_at
      FROM   shift_reports sr
      LEFT JOIN daily_nozzle_assignments dna
             ON dna.operator_id::TEXT = sr.operator_id::TEXT
            AND dna.date              = sr.date
            AND dna.shift             = sr.shift
            AND dna.pump_id           = sr.pump_id
      LEFT JOIN nozzle_readings nr
             ON nr.shift_id = sr.id
      WHERE  ${where.join(' AND ')}
      GROUP BY sr.id, dna.nozzle_ids
      ORDER  BY sr.date DESC, sr.operator
    `, vals);

    const rows = r.rows.map(s => {
      // Nozzle IDs from assignment OR from nozzle_readings JSONB
      let nozzles = [];
      if (s.assigned_nozzles) {
        nozzles = s.assigned_nozzles.split(',').filter(Boolean);
      } else {
        try {
          const readings = typeof s.nozzle_readings === 'string'
            ? JSON.parse(s.nozzle_readings) : (s.nozzle_readings || []);
          nozzles = [...new Set(readings.map(r => r.nozzleId || r.nozzle_id).filter(Boolean))];
        } catch {}
      }

      // Login time: shift_started_at → fallback to first nozzle reading → fallback to shift default
      const loginTime  = s.shift_started_at ? new Date(s.shift_started_at)
                       : s.first_reading_at  ? new Date(s.first_reading_at)
                       : null;
      const logoutTime = s.created_at ? new Date(s.created_at) : null;

      let hoursWorked = null;
      if (loginTime && logoutTime && logoutTime > loginTime) {
        const diffMs = logoutTime - loginTime;
        hoursWorked = Math.round((diffMs / 3600000) * 10) / 10; // round to 1 decimal
      }

      const loginStr  = loginTime  ? loginTime.toLocaleTimeString('en-IN',
                          { timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hour12:true }) : '—';
      const loginDateStr = loginTime ? loginTime.toLocaleDateString('en-IN',
                          { timeZone:'Asia/Kolkata', day:'2-digit', month:'short', year:'numeric' }) : '—';
      const logoutStr = logoutTime ? logoutTime.toLocaleTimeString('en-IN',
                          { timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hour12:true }) : '—';
      const logoutDateStr = logoutTime ? logoutTime.toLocaleDateString('en-IN',
                          { timeZone:'Asia/Kolkata', day:'2-digit', month:'short', year:'numeric' }) : '—';

      return {
        id:           s.id,
        operator:     s.operator || '',
        operatorId:   String(s.operator_id || ''),
        date:         String(s.date).slice(0,10),
        shift:        s.shift || '',
        loginTime:    loginStr,
        loginDate:    loginDateStr,
        logoutTime:   logoutStr,
        logoutDate:   logoutDateStr,
        hoursWorked,
        nozzles:      nozzles.join(', ') || '—',
        revenue:      parseFloat(s.total_revenue || 0),
        cash:         parseFloat(s.cash || 0),
        upi:          parseFloat(s.upi || 0),
        card:         parseFloat(s.card || 0),
        credit:       parseFloat(s.credit || 0),
        petrolVol:    parseFloat(s.petrol_vol || 0),
        dieselVol:    parseFloat(s.diesel_vol || 0),
        status:       s.status || 'Submitted',
        confirmedBy:  s.confirmed_by || '—',
        confirmedAt:  s.confirmed_at ? new Date(s.confirmed_at).toLocaleString('en-IN',
                        { timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit',
                          hour12:true, day:'2-digit', month:'short' }) : '—',
      };
    });

    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


module.exports = router;