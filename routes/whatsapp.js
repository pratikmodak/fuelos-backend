import { Router } from 'express';
import axios from 'axios';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

const router = Router();

async function getCfg() {
  const rows = await db.all('SELECT key, value FROM integration_config');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

export async function sendWhatsApp(to, message, type = 'alert', ownerId = null) {
  const cfg = await getCfg();
  const provider = cfg.wa_provider || 'meta';
  let status = 'Failed';
  let providerMsgId = null;
  try {
    if (provider === 'meta' && cfg.wa_api_key && cfg.wa_phone_number_id) {
      const res = await axios.post(
        `https://graph.facebook.com/v18.0/${cfg.wa_phone_number_id}/messages`,
        { messaging_product: 'whatsapp', to: to.replace(/[^0-9]/g,''), type: 'text', text: { body: message } },
        { headers: { Authorization: `Bearer ${cfg.wa_api_key}` } }
      );
      providerMsgId = res.data.messages?.[0]?.id;
      status = 'Delivered';
    } else {
      console.log(`[WhatsApp-DEMO] To:${to}\n${message}`);
      status = 'Delivered';
    }
  } catch (e) { console.error('[WhatsApp]', e.message); }
  if (ownerId) {
    await db.run(`INSERT INTO wa_log VALUES (?,?,?,?,?,date('now'),?,?,?,datetime('now'))`,
      [uuid(), ownerId, type, message, to, status, provider, providerMsgId]);
  }
  return { status };
}

export async function sendPaymentConfirmationWA(owner, txn) {
  if (!owner?.whatsapp || !owner?.whatsapp_num) return;
  const msg = `✅ Payment confirmed!\n*${txn.plan}* plan activated.\nAmount: *₹${txn.amount}*\n\nThank you — FuelOS`;
  return sendWhatsApp(owner.whatsapp_num, msg, 'payment', owner.id);
}

router.post('/test', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const result = await sendWhatsApp(req.body.to, req.body.message, 'test');
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/log', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    res.json(await db.all('SELECT wl.*, o.name as owner_name FROM wa_log wl LEFT JOIN owners o ON wl.owner_id=o.id ORDER BY wl.created_at DESC LIMIT 200'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/stats', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    res.json(await db.all(`
      SELECT owner_id,
        COUNT(*) AS total_messages,
        SUM(CASE WHEN status='Delivered' THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN status='Failed' THEN 1 ELSE 0 END) AS failed
      FROM wa_log GROUP BY owner_id`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
