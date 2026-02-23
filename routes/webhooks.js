// ═══════════════════════════════════════════════════════════
// FuelOS — Razorpay Webhook Handler
// POST /api/webhooks/razorpay
//
// Events handled:
//   payment.captured    → activate plan immediately
//   payment.failed      → mark transaction failed
//   refund.created      → log refund
// ═══════════════════════════════════════════════════════════
import { Router } from 'express';
import crypto     from 'crypto';
import { v4 as uuid } from 'uuid';
import { db }     from '../db.js';
import { sendPaymentConfirmationWA } from './whatsapp.js';

const router = Router();

function getWebhookSecret() {
  const row = db.get('SELECT value FROM integration_config WHERE key=?', ['rzp_webhook_secret']);
  return row?.value || process.env.RAZORPAY_WEBHOOK_SECRET || '';
}

// Signature verification
function verifySignature(rawBody, signature) {
  const secret = getWebhookSecret();
  if (!secret) return true; // demo mode: skip
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || ''));
}

function addMonths(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

// POST /api/webhooks/razorpay
router.post('/razorpay', (req, res) => {
  const sig  = req.headers['x-razorpay-signature'];
  const body = req.body; // raw Buffer (express.raw middleware)

  if (!verifySignature(body, sig)) {
    console.warn('[Webhook] Invalid signature — rejected');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  console.log('[Webhook] Event:', event.event, event.payload?.payment?.entity?.id);

  try {
    switch (event.event) {

      case 'payment.captured': {
        const payment = event.payload.payment.entity;
        const { ownerId, plan, billing } = payment.notes || {};
        if (!ownerId) break;

        const amount = payment.amount / 100; // paise → rupees
        const gst    = Math.round(amount * 0.18 / 1.18);
        const base   = amount - gst;

        const txnId  = 'TXN-W' + Date.now().toString().slice(-6);
        const endDate = billing === 'yearly' ? addMonths(12) : addMonths(1);

        db.tx(() => {
          // Upsert transaction
          db.run(`INSERT OR REPLACE INTO transactions
                  (id,owner_id,plan,billing,amount,base,gst,credit,date,method,status,razorpay_id,plan_activated,webhook_event,created_at,updated_at)
                  VALUES (?,?,?,?,?,?,?,0,date('now'),?,?,?,1,?,datetime('now'),datetime('now'))`,
            [txnId, ownerId, plan || 'Pro', billing || 'monthly',
             amount, base, gst, payment.method?.toUpperCase() || 'UPI',
             'Success', payment.id, 'payment.captured']);

          // ── Auto-activate plan
          db.run(`UPDATE owners SET plan=?, billing=?, status='Active',
                  start_date=date('now'), end_date=?, days_used=0,
                  amount_paid=?, updated_at=datetime('now') WHERE id=?`,
            [plan || 'Pro', billing || 'monthly', endDate, base, ownerId]);

          db.run(`INSERT INTO audit_log VALUES (?,?,?,?,?,datetime('now'))`,
            [uuid(), ownerId, 'System', `Webhook: ${plan} plan auto-activated via payment.captured`, '0.0.0.0']);
        });

        // Send WA confirmation
        const owner = db.get('SELECT * FROM owners WHERE id=?', [ownerId]);
        if (owner) {
          sendPaymentConfirmationWA(owner, { plan, billing, amount }).catch(console.error);
        }

        console.log(`[Webhook] ✓ Plan ${plan} activated for owner ${ownerId}`);
        break;
      }

      case 'payment.failed': {
        const payment = event.payload.payment.entity;
        const { ownerId } = payment.notes || {};
        const reason = payment.error_description || 'Payment failed';

        db.run(`UPDATE transactions SET status='Failed', fail_reason=?,
                webhook_event='payment.failed', updated_at=datetime('now')
                WHERE razorpay_id=?`, [reason, payment.id]);

        // Create notification for owner
        if (ownerId) {
          db.run(`INSERT INTO notifications VALUES (?,?,NULL,'alert',?,?,0,datetime('now'))`,
            [uuid(), ownerId, `Payment failed: ${reason}`, 'just now']);
        }
        console.log(`[Webhook] ✗ Payment failed: ${reason}`);
        break;
      }

      case 'refund.created': {
        const refund = event.payload.refund.entity;
        db.run(`UPDATE transactions SET status='Refunded', updated_at=datetime('now')
                WHERE razorpay_id=?`, [refund.payment_id]);
        console.log(`[Webhook] Refund created for payment ${refund.payment_id}`);
        break;
      }
    }
  } catch (err) {
    console.error('[Webhook] Processing error:', err.message);
  }

  // Always return 200 to acknowledge receipt
  res.json({ received: true });
});

export default router;
