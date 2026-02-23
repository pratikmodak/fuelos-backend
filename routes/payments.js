import { Router } from 'express';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { sendPaymentConfirmationWA } from './whatsapp.js';

const router = Router();

const PLANS = {
  Starter:    { price: 799,  yearly: 7990  },
  Pro:        { price: 2499, yearly: 24990 },
  Enterprise: { price: 5999, yearly: 59990 },
};

async function getCfg() {
  const rows = await db.all('SELECT key, value FROM integration_config');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

router.post('/create-order', authMiddleware, requireRole('owner'), async (req, res) => {
  try {
    const { plan, billing, couponCode } = req.body;
    const owner = await db.get('SELECT * FROM owners WHERE id=?', [req.user.id]);
    if (!owner) return res.status(404).json({ error: 'Owner not found' });
    const p = PLANS[plan];
    if (!p) return res.status(400).json({ error: 'Invalid plan' });
    let base = billing === 'yearly' ? p.yearly : p.price;
    let discount = 0;
    if (couponCode) {
      const coupon = await db.get('SELECT * FROM coupons WHERE code=? AND status=?', [couponCode.toUpperCase(), 'Active']);
      if (coupon && coupon.uses < coupon.max_uses) {
        discount = coupon.type === 'flat' ? coupon.discount : Math.round(base * coupon.discount / 100);
      }
    }
    const afterDiscount = Math.max(0, base - discount);
    const gst   = Math.round(afterDiscount * 0.18);
    const total = afterDiscount + gst;
    const txnId = 'TXN-' + Math.floor(8000 + Math.random() * 999);
    await db.run(`INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?,date('now'),?,?,?,?,0,NULL,NULL,datetime('now'),datetime('now'))`,
      [txnId, owner.id, plan, billing, total, afterDiscount, gst, 0, 'Pending', `order_demo_${Date.now()}`, null]);
    res.json({ txnId, amount: total, base: afterDiscount, gst, discount, plan, billing });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/verify', authMiddleware, requireRole('owner'), async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, txnId } = req.body;
    const txn = await db.get('SELECT * FROM transactions WHERE id=?', [txnId]);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    const newEndDate = txn.billing === 'yearly'
      ? new Date(Date.now() + 365*86400000).toISOString().slice(0,10)
      : new Date(Date.now() +  30*86400000).toISOString().slice(0,10);
    await db.tx(async () => {
      await db.run(`UPDATE owners SET plan=?, billing=?, status='Active', start_date=date('now'),
        end_date=?, days_used=0, amount_paid=?, updated_at=datetime('now') WHERE id=?`,
        [txn.plan, txn.billing, newEndDate, txn.base, txn.owner_id]);
      await db.run(`UPDATE transactions SET status='Success', razorpay_id=?, plan_activated=1, updated_at=datetime('now') WHERE id=?`,
        [razorpay_payment_id, txnId]);
      await db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
        [uuid(), txn.owner_id, 'Owner', `Payment success — ${txn.plan} activated`, req.ip]);
    });
    const owner = await db.get('SELECT * FROM owners WHERE id=?', [txn.owner_id]);
    sendPaymentConfirmationWA(owner, txn).catch(console.error);
    res.json({ success: true, plan: txn.plan, endDate: newEndDate });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/history', authMiddleware, requireRole('owner'), async (req, res) => {
  try {
    res.json(await db.all('SELECT * FROM transactions WHERE owner_id=? ORDER BY created_at DESC', [req.user.id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
