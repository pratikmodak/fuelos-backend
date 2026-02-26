// routes/payments.js
const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// Razorpay instance (optional — only if keys are set)
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  const Razorpay = require('razorpay');
  razorpay = new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

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
    const credit = 0; // coupon logic here if needed
    const gst    = Math.round((base - credit) * 0.18);
    const amount = base - credit + gst;

    if (!razorpay) {
      // Demo mode — return fake order
      return res.json({
        order_id:   'order_demo_' + Date.now(),
        amount,
        base,
        gst,
        credit,
        currency:   'INR',
        demo:       true,
        key:        process.env.RAZORPAY_KEY_ID || 'rzp_test_demo',
      });
    }

    const order = await razorpay.orders.create({
      amount:   amount * 100,
      currency: 'INR',
      receipt:  `fuelos_${req.user.owner_id}_${Date.now()}`,
      notes:    { plan, billing, owner_id: String(req.user.owner_id) },
    });

    res.json({ order_id: order.id, amount, base, gst, credit, currency: 'INR', key: process.env.RAZORPAY_KEY_ID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/payments/verify
router.post('/verify', requireAuth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, txnId, plan, billing } = req.body;
    const ownerId = req.user.owner_id || req.user.id;

    // Verify Razorpay signature
    if (razorpay && razorpay_signature) {
      const crypto = require('crypto');
      const body = razorpay_order_id + '|' + razorpay_payment_id;
      const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(body).digest('hex');
      if (expected !== razorpay_signature) {
        return res.status(400).json({ error: 'Payment verification failed' });
      }
    }

    // Fetch order details to get plan info
    let orderPlan = plan, orderBilling = billing;
    if (razorpay && razorpay_order_id && !razorpay_order_id.startsWith('order_demo')) {
      try {
        const order = await razorpay.orders.fetch(razorpay_order_id);
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
