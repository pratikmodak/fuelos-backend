const wa = require('../services/whatsapp');
// routes/payments.js
const router  = require('express').Router();
const db      = require('../db');
const crypto  = require('crypto');
const { requireAuth } = require('../middleware/auth');

// Get Razorpay keys — DB wins over env vars (admin can update via UI without redeploy)
const getRazorpayKeys = async () => {
  try {
    // Auto-create app_config if it doesn't exist (handles fresh DB deployments)
    await db.query(`CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(() => {});
    const r = await db.query(
      "SELECT key, value FROM app_config WHERE key IN ('rzp_live_key_id','rzp_live_key_secret','rzp_test_key_id','rzp_test_key_secret','rzp_mode')"
    );
    const cfg = {};
    r.rows.forEach(row => { cfg[row.key] = row.value; });
    const mode      = cfg.rzp_mode || 'test';
    const keyId     = mode === 'live'
      ? (cfg.rzp_live_key_id     || process.env.RAZORPAY_KEY_ID     || '')
      : (cfg.rzp_test_key_id     || process.env.RAZORPAY_KEY_ID     || '');
    const keySecret = mode === 'live'
      ? (cfg.rzp_live_key_secret || process.env.RAZORPAY_KEY_SECRET || '')
      : (cfg.rzp_test_key_secret || process.env.RAZORPAY_KEY_SECRET || '');
    return { keyId, keySecret, mode };
  } catch {
    return {
      keyId:     process.env.RAZORPAY_KEY_ID     || '',
      keySecret: process.env.RAZORPAY_KEY_SECRET || '',
      mode:      'test',
    };
  }
};

// Build Razorpay instance lazily per-request so admin key changes take effect immediately
const getRazorpay = async () => {
  const { keyId, keySecret } = await getRazorpayKeys();
  if (!keyId || !keySecret) return null;
  const Razorpay = require('razorpay');
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

const PLANS = {
  Starter:    { monthly: 799,  yearly: 7990  },
  Pro:        { monthly: 2499, yearly: 24990 },
  Enterprise: { monthly: 5999, yearly: 59990 },
};

// POST /api/payments/create-order
router.post('/create-order', requireAuth, async (req, res) => {
  try {
    const { plan, billing, couponCode } = req.body;
    const planPrices = PLANS[plan];
    if (!planPrices) return res.status(400).json({ error: 'Invalid plan' });

    const base   = planPrices[billing] || planPrices.monthly;
    const credit = 0;
    const gst    = Math.round((base - credit) * 0.18);
    const amount = base - credit + gst;

    const { keyId, keySecret, mode } = await getRazorpayKeys();
    const rzp = await getRazorpay();

    if (!rzp) {
      // No keys configured — demo mode
      return res.json({
        order_id: 'order_demo_' + Date.now(),
        amount, base, gst, credit,
        currency: 'INR',
        demo: true,
        key: keyId || 'rzp_test_demo',
      });
    }

    let order;
    try {
      order = await rzp.orders.create({
        amount:   Math.round(amount * 100), // paise, must be integer
        currency: 'INR',
        receipt:  `fuel_${Date.now()}`,    // keep short, no special chars
        notes:    { plan, billing, owner_id: String(req.user.owner_id || req.user.id) },
      });
    } catch (rzpErr) {
      console.error('[payments/create-order] Razorpay API error:', rzpErr.message);
      // Razorpay API failed (bad keys, network, etc.) — return demo order so checkout still works
      return res.json({
        order_id: 'order_demo_' + Date.now(),
        amount, base, gst, credit,
        currency: 'INR',
        demo: true,
        key: keyId,
        _rzp_error: rzpErr.message, // for debugging, not shown to user
      });
    }

    res.json({
      order_id: order.id, amount, base, gst, credit,
      currency: 'INR', key: keyId, mode,
    });
  } catch (e) {
    console.error('[payments/create-order] ERROR:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/payments/verify
router.post('/verify', requireAuth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, txnId, plan, billing } = req.body;
    const ownerId = req.user.owner_id || req.user.id;

    const { keySecret } = await getRazorpayKeys();
    const rzp = await getRazorpay();

    // Verify Razorpay signature
    if (rzp && razorpay_signature && keySecret) {
      const body     = razorpay_order_id + '|' + razorpay_payment_id;
      const expected = crypto.createHmac('sha256', keySecret).update(body).digest('hex');
      if (expected !== razorpay_signature) {
        return res.status(400).json({ error: 'Payment verification failed' });
      }
    }

    // Fetch order details to get plan info
    let orderPlan = plan, orderBilling = billing;
    if (rzp && razorpay_order_id && !razorpay_order_id.startsWith('order_demo')) {
      try {
        const order = await rzp.orders.fetch(razorpay_order_id);
        orderPlan    = order.notes?.plan    || plan;
        orderBilling = order.notes?.billing || billing;
      } catch {}
    }

    if (orderPlan) {
      const planPrices = PLANS[orderPlan] || {};
      const base  = planPrices[orderBilling||'monthly'] || 0;
      const gst   = Math.round(base * 0.18);
      const amount = base + gst;

      const today    = new Date().toISOString().slice(0, 10);
      const addMonths = (d, m) => { const dt = new Date(d); dt.setMonth(dt.getMonth() + m); return dt.toISOString().slice(0,10); };
      const endDate  = addMonths(today, orderBilling === 'yearly' ? 12 : 1);

      // Update owner plan
      await db.query(
        `UPDATE owners SET plan=$1, billing=$2, status='Active',
         start_date=$3, end_date=$4, amount_paid=$5, updated_at=NOW()
         WHERE id=$6`,
        [orderPlan, orderBilling||'monthly', today, endDate, base, ownerId]
      );

      // Save transaction
      await db.query(
        `INSERT INTO transactions (id,owner_id,plan,billing,amount,base,gst,date,method,status,razor_id,plan_activated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Success',$10,TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [txnId||('TXN-'+Date.now()), ownerId, orderPlan, orderBilling||'monthly',
         amount, base, gst, today, razorpay_payment_id ? 'Razorpay' : 'Demo',
         razorpay_payment_id||null]
      );
    }

    res.json({ ok: true, verified: true });

    // Non-blocking WA notification to owner
    setImmediate(async () => {
      try {
        if (!orderPlan) return;
        const ownerRow = await db.query(
          'SELECT whatsapp_num, end_date FROM owners WHERE id=$1', [ownerId]
        );
        const o = ownerRow.rows[0];
        if (!o?.whatsapp_num) return;
        const PRICES = { Starter:{monthly:799,yearly:7990}, Pro:{monthly:2499,yearly:24990}, Enterprise:{monthly:5999,yearly:59990} };
        const b = (PRICES[orderPlan]||{})[orderBilling||'monthly'] || 0;
        await wa.notifyPaymentSuccess(o.whatsapp_num, {
          plan:      orderPlan,
          billing:   orderBilling === 'yearly' ? 'Annual' : 'Monthly',
          amount:    b + Math.round(b * 0.18),
          validTill: o.end_date ? new Date(o.end_date).toLocaleDateString('en-IN') : '',
        });
      } catch (e) { console.warn('[payments/verify/wa]', e.message); }
    });
  } catch (e) {
    console.error('[payments/verify]', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/payments/history
router.get('/history', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner_id || req.user.id;
    const r = await db.query(
      'SELECT * FROM transactions WHERE owner_id=$1 ORDER BY date DESC, created_at DESC LIMIT 50',
      [ownerId]
    );
    res.json(r.rows.map(t => ({
      id: t.id, plan: t.plan, billing: t.billing,
      amount: parseFloat(t.amount||0), base: parseFloat(t.base||0),
      gst: parseFloat(t.gst||0), credit: parseFloat(t.credit||0),
      date: t.date, method: t.method, status: t.status,
      razorId: t.razor_id, planActivated: t.plan_activated,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;