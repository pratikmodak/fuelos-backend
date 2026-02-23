import { Router } from 'express';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { sendPaymentConfirmationWA } from './whatsapp.js';

const router = Router();

async function getWebhookSecret() {
  const row = await db.get('SELECT value FROM integration_config WHERE key=?', ['rzp_webhook_secret']);
  return row?.value || process.env.RAZORPAY_WEBHOOK_SECRET || '';
}

router.post('/razorpay', async (req, res) => {
  try {
    const sig  = req.headers['x-razorpay-signature'];
    const body = req.body;
    const secret = await getWebhookSecret();
    if (secret && sig) {
      const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
        return res.status(400).json({ error: 'Invalid signature' });
      }
    }
    const event = JSON.parse(body.toString());
    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;
      const { ownerId, plan, billing } = payment.notes || {};
      if (ownerId) {
        const amount = payment.amount / 100;
        const gst = Math.round(amount * 0.18 / 1.18);
        const endDate = billing === 'yearly'
          ? new Date(Date.now()+365*86400000).toISOString().slice(0,10)
          : new Date(Date.now()+30*86400000).toISOString().slice(0,10);
        await db.tx(async () => {
          await db.run(`INSERT OR REPLACE INTO transactions
            (id,owner_id,plan,billing,amount,base,gst,credit,date,method,status,razorpay_id,plan_activated,webhook_event,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,0,date('now'),?,'Success',?,1,?,datetime('now'),datetime('now'))`,
            ['TXN-W'+Date.now().toString().slice(-6), ownerId, plan||'Pro', billing||'monthly',
             amount, amount-gst, gst, payment.method||'UPI', payment.id, 'payment.captured']);
          await db.run(`UPDATE owners SET plan=?, billing=?, status='Active', start_date=date('now'),
            end_date=?, days_used=0, amount_paid=?, updated_at=datetime('now') WHERE id=?`,
            [plan||'Pro', billing||'monthly', endDate, amount-gst, ownerId]);
        });
        const owner = await db.get('SELECT * FROM owners WHERE id=?', [ownerId]);
        if (owner) sendPaymentConfirmationWA(owner, { plan, billing, amount }).catch(console.error);
      }
    } else if (event.event === 'payment.failed') {
      const payment = event.payload.payment.entity;
      await db.run(`UPDATE transactions SET status='Failed', fail_reason=?, updated_at=datetime('now') WHERE razorpay_id=?`,
        [payment.error_description||'Payment failed', payment.id]);
    }
    res.json({ received: true });
  } catch (e) { console.error('[Webhook]', e.message); res.json({ received: true }); }
});

export default router;
