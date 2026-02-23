// ═══════════════════════════════════════════════════════════
// FuelOS — Payment Routes (Razorpay)
// POST /api/payments/create-order
// POST /api/payments/verify
// GET  /api/payments/history
// ═══════════════════════════════════════════════════════════
import { Router }  from 'express';
import Razorpay    from 'razorpay';
import crypto      from 'crypto';
import { v4 as uuid } from 'uuid';
import { db }      from '../db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { sendPaymentConfirmationWA }   from './whatsapp.js';

const router = Router();

function getRazorpay() {
  const cfg = getIntegConfig();
  const keyId     = cfg.rzp_mode === 'live' ? cfg.rzp_live_key_id     : cfg.rzp_test_key_id;
  const keySecret = cfg.rzp_mode === 'live' ? cfg.rzp_live_key_secret : cfg.rzp_test_key_secret;
  if (!keyId || !keySecret) return null;
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

function getIntegConfig() {
  const rows = db.all('SELECT key, value FROM integration_config');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

const PLANS = {
  Starter:    { price: 799,  yearly: 7990,  pumps: 1, nozzles: 5 },
  Pro:        { price: 2499, yearly: 24990, pumps: 3, nozzles: 20 },
  Enterprise: { price: 5999, yearly: 59990, pumps: 999, nozzles: 999 },
};

// POST /api/payments/create-order — create Razorpay order
router.post('/create-order', authMiddleware, requireRole('owner'), async (req, res) => {
  try {
    const { plan, billing, couponCode } = req.body;
    const owner = db.get('SELECT * FROM owners WHERE id=?', [req.user.id]);
    if (!owner) return res.status(404).json({ error: 'Owner not found' });

    const p = PLANS[plan];
    if (!p) return res.status(400).json({ error: 'Invalid plan' });

    let base = billing === 'yearly' ? p.yearly : p.price;

    // Apply coupon
    let discount = 0, coupon = null;
    if (couponCode) {
      coupon = db.get('SELECT * FROM coupons WHERE code=? AND status=?', [couponCode.toUpperCase(), 'Active']);
      if (coupon && coupon.uses < coupon.max_uses) {
        discount = coupon.type === 'flat' ? coupon.discount : Math.round(base * coupon.discount / 100);
      }
    }

    // Pro-rata credit for upgrade
    let credit = 0;
    const planRank = { Starter: 1, Pro: 2, Enterprise: 3 };
    if (planRank[plan] > planRank[owner.plan] && owner.amount_paid > 0) {
      const totalDays = owner.billing === 'yearly' ? 365 : 30;
      const remaining = Math.max(0, totalDays - (owner.days_used || 0));
      credit = Math.round((owner.amount_paid / totalDays) * remaining);
    }

    const afterDiscount = Math.max(0, base - discount - credit);
    const gst   = Math.round(afterDiscount * 0.18);
    const total = afterDiscount + gst;

    const rzp = getRazorpay();
    let orderId = `order_demo_${Date.now()}`;

    if (rzp) {
      const order = await rzp.orders.create({
        amount: total * 100, // paise
        currency: 'INR',
        receipt: `fuelos_${owner.id}_${Date.now()}`,
        notes: { ownerId: owner.id, plan, billing },
      });
      orderId = order.id;
    }

    // Store pending transaction
    const txnId = 'TXN-' + Math.floor(8000 + Math.random() * 999);
    db.run(`INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?,date('now'),?,?,?,0,NULL,NULL,datetime('now'),datetime('now'))`,
      [txnId, owner.id, plan, billing, total, afterDiscount, gst, credit, 'Pending', orderId, null]);

    res.json({ orderId, txnId, amount: total, base: afterDiscount, gst, credit, discount, plan, billing });
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/verify — verify payment signature + activate plan
router.post('/verify', authMiddleware, requireRole('owner'), async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, txnId } = req.body;
    const cfg = getIntegConfig();

    // Verify signature
    let verified = false;
    if (razorpay_signature && cfg.rzp_webhook_secret) {
      const body = razorpay_order_id + '|' + razorpay_payment_id;
      const expected = crypto.createHmac('sha256', cfg.rzp_webhook_secret).update(body).digest('hex');
      verified = expected === razorpay_signature;
    } else {
      verified = true; // demo mode: skip verification
    }

    if (!verified) return res.status(400).json({ error: 'Payment verification failed' });

    // Get transaction
    const txn = db.get('SELECT * FROM transactions WHERE id=?', [txnId]);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });

    // Activate plan ── this is the key operation
    const newEndDate = txn.billing === 'yearly'
      ? new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10)
      : new Date(Date.now() +  30 * 86400000).toISOString().slice(0, 10);

    db.tx(() => {
      // Update owner plan
      db.run(`UPDATE owners SET plan=?, billing=?, status='Active', start_date=date('now'),
              end_date=?, days_used=0, amount_paid=?, updated_at=datetime('now') WHERE id=?`,
        [txn.plan, txn.billing, newEndDate, txn.base, txn.owner_id]);

      // Mark transaction success
      db.run(`UPDATE transactions SET status='Success', razorpay_id=?, razorpay_sig=?,
              plan_activated=1, updated_at=datetime('now') WHERE id=?`,
        [razorpay_payment_id, razorpay_signature, txnId]);

      // Audit log
      db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
        [uuid(), txn.owner_id, 'Owner', `Payment success — ${txn.plan} plan activated`, req.ip]);
    });

    // Fetch updated owner
    const owner = db.get('SELECT * FROM owners WHERE id=?', [txn.owner_id]);

    // Send WhatsApp confirmation (non-blocking)
    sendPaymentConfirmationWA(owner, txn).catch(console.error);

    res.json({ success: true, plan: txn.plan, endDate: newEndDate, owner });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/history
router.get('/history', authMiddleware, requireRole('owner'), (req, res) => {
  const txns = db.all('SELECT * FROM transactions WHERE owner_id=? ORDER BY created_at DESC', [req.user.id]);
  res.json(txns);
});

export default router;
