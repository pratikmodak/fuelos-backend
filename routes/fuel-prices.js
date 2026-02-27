// routes/fuel-prices.js
const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/fuel-prices — all rates + 30-day history
router.get('/', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const r = await db.query(
      `SELECT fp.id, fp.owner_id, fp.pump_id, fp.petrol, fp.diesel, fp.cng,
              fp.effective_date, p.name as pump_name, p.short_name as pump_short_name
       FROM fuel_prices fp
       JOIN pumps p ON p.id = fp.pump_id
       WHERE fp.owner_id=$1
       ORDER BY fp.effective_date DESC, fp.pump_id
       LIMIT 200`,
      [ownerId]
    );
    const all = r.rows.map(fp => ({
      id:            fp.id,
      ownerId:       String(fp.owner_id),
      owner_id:      String(fp.owner_id),
      pumpId:        fp.pump_id,
      pump_id:       fp.pump_id,
      pumpName:      fp.pump_short_name || fp.pump_name,
      petrol:        parseFloat(fp.petrol || 0),
      diesel:        parseFloat(fp.diesel || 0),
      cng:           parseFloat(fp.cng    || 0),
      effectiveDate: fp.effective_date,
      effective_date: fp.effective_date,
      date:          fp.effective_date,
    }));
    // Return shape frontend expects: { latest: [...], history: [...] }
    // latest = most recent entry per pump, history = all
    const latestMap = {};
    all.forEach(fp => { if (!latestMap[fp.pump_id]) latestMap[fp.pump_id] = fp; });
    res.json({ latest: Object.values(latestMap), history: all });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/fuel-prices/today?pump_id=X
router.get('/today', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { pump_id } = req.query;
    const r = await db.query(
      `SELECT * FROM fuel_prices WHERE owner_id=$1 AND pump_id=$2
       ORDER BY effective_date DESC LIMIT 1`,
      [ownerId, pump_id]
    );
    const fp = r.rows[0];
    res.json(fp ? {
      pumpId: fp.pump_id, petrol: parseFloat(fp.petrol||0),
      diesel: parseFloat(fp.diesel||0), cng: parseFloat(fp.cng||0),
      date: fp.effective_date,
    } : { pumpId: pump_id, petrol: 0, diesel: 0, cng: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/fuel-prices — set rates for one pump
router.post('/', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { pump_id, rates, effective_date } = req.body;
    const date = effective_date || new Date().toISOString().slice(0,10);
    // Accept both capitalized (Petrol) and lowercase (petrol) keys from frontend
    const petrol = rates.Petrol || rates.petrol || 0;
    const diesel = rates.Diesel || rates.diesel || 0;
    const cng    = rates.CNG    || rates.cng    || 0;
    await db.query(
      `INSERT INTO fuel_prices (owner_id,pump_id,petrol,diesel,cng,effective_date)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (owner_id,pump_id,effective_date)
       DO UPDATE SET petrol=$3, diesel=$4, cng=$5`,
      [ownerId, pump_id, petrol, diesel, cng, date]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/fuel-prices/all-pumps — set same rates for all pumps
router.post('/all-pumps', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const { rates, effective_date } = req.body;
    const date = effective_date || new Date().toISOString().slice(0,10);
    const pumps = await db.query('SELECT id FROM pumps WHERE owner_id=$1', [ownerId]);
    for (const p of pumps.rows) {
      const petrol = rates.Petrol || rates.petrol || 0;
      const diesel = rates.Diesel || rates.diesel || 0;
      const cng    = rates.CNG    || rates.cng    || 0;
      await db.query(
        `INSERT INTO fuel_prices (owner_id,pump_id,petrol,diesel,cng,effective_date)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (owner_id,pump_id,effective_date)
         DO UPDATE SET petrol=$3, diesel=$4, cng=$5`,
        [ownerId, p.id, petrol, diesel, cng, date]
      );
    }
    res.json({ ok: true, pumps: pumps.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});



// ─────────────────────────────────────────────────────────────
// GET /api/fuel-prices/market?city=pune
// Returns reference price from static IOC/HPCL city table
// Owner sees prices pre-filled in inputs and can edit before saving
// ─────────────────────────────────────────────────────────────
router.get('/market', requireAuth, async (req, res) => {
  const city = (req.query.city || '').trim();
  if (!city) return res.status(400).json({ error: 'city parameter required' });

  const raw = city.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, '');

  // Inline static price table — IOC/HPCL published retail rates
  const PRICES = {
    pune:        { petrol: 103.44, diesel: 89.97, cng: 74.00 },
    mumbai:      { petrol: 103.44, diesel: 89.97, cng: 74.00 },
    nagpur:      { petrol: 103.97, diesel: 90.25, cng: 76.00 },
    nashik:      { petrol: 103.55, diesel: 90.05, cng: 75.00 },
    aurangabad:  { petrol: 104.10, diesel: 90.40, cng: 0      },
    delhi:       { petrol: 94.72,  diesel: 87.62, cng: 74.09  },
    noida:       { petrol: 94.67,  diesel: 87.76, cng: 79.32  },
    gurgaon:     { petrol: 95.19,  diesel: 88.06, cng: 76.59  },
    faridabad:   { petrol: 95.15,  diesel: 88.02, cng: 76.59  },
    bangalore:   { petrol: 102.86, diesel: 88.94, cng: 0       },
    bengaluru:   { petrol: 102.86, diesel: 88.94, cng: 0       },
    mysore:      { petrol: 102.79, diesel: 88.84, cng: 0       },
    chennai:     { petrol: 102.63, diesel: 94.24, cng: 0       },
    coimbatore:  { petrol: 102.55, diesel: 94.16, cng: 0       },
    hyderabad:   { petrol: 107.41, diesel: 95.65, cng: 0       },
    warangal:    { petrol: 108.20, diesel: 96.20, cng: 0       },
    ahmedabad:   { petrol: 96.63,  diesel: 92.38, cng: 86.00  },
    surat:       { petrol: 96.50,  diesel: 92.25, cng: 85.00  },
    vadodara:    { petrol: 96.45,  diesel: 92.20, cng: 85.00  },
    rajkot:      { petrol: 96.60,  diesel: 92.35, cng: 85.00  },
    jaipur:      { petrol: 104.88, diesel: 90.36, cng: 79.00  },
    jodhpur:     { petrol: 105.20, diesel: 90.60, cng: 0       },
    lucknow:     { petrol: 94.65,  diesel: 87.76, cng: 79.32  },
    kanpur:      { petrol: 94.58,  diesel: 87.69, cng: 79.32  },
    agra:        { petrol: 94.52,  diesel: 87.63, cng: 79.32  },
    varanasi:    { petrol: 94.72,  diesel: 87.92, cng: 0       },
    chandigarh:  { petrol: 94.24,  diesel: 82.70, cng: 0       },
    ludhiana:    { petrol: 96.22,  diesel: 84.51, cng: 0       },
    amritsar:    { petrol: 96.22,  diesel: 84.51, cng: 0       },
    kolkata:     { petrol: 103.94, diesel: 90.76, cng: 0       },
    bhopal:      { petrol: 107.23, diesel: 92.27, cng: 0       },
    indore:      { petrol: 107.31, diesel: 92.35, cng: 0       },
    patna:       { petrol: 107.24, diesel: 94.04, cng: 0       },
    bhubaneswar: { petrol: 103.19, diesel: 94.76, cng: 0       },
    guwahati:    { petrol: 96.01,  diesel: 83.94, cng: 0       },
    kochi:       { petrol: 107.66, diesel: 96.42, cng: 0       },
    thiruvananthapuram: { petrol: 107.71, diesel: 96.47, cng: 0 },
    panaji:      { petrol: 95.10,  diesel: 88.55, cng: 0       },
    ranchi:      { petrol: 99.84,  diesel: 94.55, cng: 0       },
  };

  let prices = PRICES[raw];
  if (!prices) {
    const key = Object.keys(PRICES).find(k => raw.includes(k) || k.includes(raw));
    prices = key ? PRICES[key] : null;
  }

  if (!prices) {
    return res.status(404).json({
      error: `No reference data for "${city}"`,
      hint: 'Supported: pune, mumbai, delhi, bangalore, hyderabad, chennai, ahmedabad, jaipur, kolkata, lucknow...',
    });
  }

  res.json({
    city,
    petrol: prices.petrol,
    diesel: prices.diesel,
    cng:    prices.cng || 0,
    date:   new Date().toISOString().slice(0, 10),
    source: 'IOC/HPCL reference',
    note:   'Reference rates — review and edit before saving',
  });
});

module.exports = router;