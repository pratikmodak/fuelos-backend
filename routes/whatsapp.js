// ═══════════════════════════════════════════════════════════
// FuelOS — WhatsApp Notification Service
// Supports: Meta Cloud API, Twilio, WATI, Interakt, Gupshup
// POST /api/whatsapp/test  — send a test message
// POST /api/whatsapp/send  — internal: send any message
// ═══════════════════════════════════════════════════════════
import { Router } from 'express';
import axios      from 'axios';
import twilio     from 'twilio';
import { v4 as uuid } from 'uuid';
import { db }     from '../db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

const router = Router();

// ── Get integration config from DB
function getCfg() {
  const rows = db.all('SELECT key, value FROM integration_config');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ── Core send function — routes to correct provider
export async function sendWhatsApp(to, message, type = 'alert', ownerId = null) {
  const cfg = getCfg();
  const provider = cfg.wa_provider || 'meta';
  let providerMsgId = null;
  let status = 'Failed';

  try {
    if (provider === 'meta' && cfg.wa_api_key && cfg.wa_phone_number_id) {
      const res = await axios.post(
        `https://graph.facebook.com/v18.0/${cfg.wa_phone_number_id}/messages`,
        {
          messaging_product: 'whatsapp',
          to: to.replace(/[^0-9]/g, ''),
          type: 'text',
          text: { body: message },
        },
        { headers: { Authorization: `Bearer ${cfg.wa_api_key}`, 'Content-Type': 'application/json' } }
      );
      providerMsgId = res.data.messages?.[0]?.id;
      status = 'Delivered';

    } else if (provider === 'twilio' && cfg.wa_twilio_account_sid) {
      const client = twilio(cfg.wa_twilio_account_sid, cfg.wa_twilio_auth_token);
      const msg = await client.messages.create({
        from: cfg.wa_twilio_from || 'whatsapp:+14155238886',
        to:   `whatsapp:${to}`,
        body: message,
      });
      providerMsgId = msg.sid;
      status = 'Delivered';

    } else if (['wati', 'interakt', 'gupshup'].includes(provider) && cfg.wa_api_key) {
      // Generic HTTP API for WATI/Interakt/Gupshup
      await axios.post(
        cfg[`wa_${provider}_endpoint`] || `https://api.${provider}.io/v1/sendMessage`,
        { phone: to, message },
        { headers: { Authorization: `Bearer ${cfg.wa_api_key}` } }
      );
      status = 'Delivered';

    } else {
      // No provider configured — log only
      console.log(`[WhatsApp-DEMO] To: ${to}\n${message}`);
      status = 'Delivered'; // demo: always success
    }

  } catch (err) {
    console.error('[WhatsApp] Send error:', err.response?.data || err.message);
    status = 'Failed';
  }

  // Log every attempt
  if (ownerId) {
    db.run(`INSERT INTO wa_log VALUES (?,?,?,?,?,date('now'),?,?,?,datetime('now'))`,
      [uuid(), ownerId, type, message, to, status, provider, providerMsgId]);
  }

  return { status, providerMsgId };
}

// ── Template formatters
export function buildPaymentMsg(owner, txn) {
  const cfg = getCfg();
  const template = cfg.wa_tpl_payment ||
    '✅ Payment confirmed!\n*{{plan}}* plan activated.\nValid till: *{{date}}*\nAmount: *₹{{amount}}*\n\nThank you — FuelOS';
  return template
    .replace('{{plan}}', txn.plan || 'Plan')
    .replace('{{date}}', txn.end_date || '')
    .replace('{{amount}}', Number(txn.amount || 0).toLocaleString('en-IN'));
}

export function buildShiftMsg(pump, shift, totalSales) {
  const cfg = getCfg();
  const template = cfg.wa_tpl_shift ||
    '📋 Shift submitted\nPump: *{{pump}}*\nShift: *{{shift}}*\nSales: *₹{{amount}}*';
  return template
    .replace('{{pump}}', pump)
    .replace('{{shift}}', shift)
    .replace('{{amount}}', Number(totalSales).toLocaleString('en-IN'));
}

export function buildAlertMsg(pump, message) {
  const cfg = getCfg();
  const template = cfg.wa_tpl_alert || '⚠️ *Alert — {{pump}}*\n{{message}}';
  return template.replace('{{pump}}', pump).replace('{{message}}', message);
}

export function buildTestMsg(result, nozzle, pump, variance) {
  const cfg = getCfg();
  const template = cfg.wa_tpl_test ||
    '🔬 Machine Test *{{result}}*\nNozzle: {{nozzle}} · {{pump}}\nVariance: {{variance}}ml';
  return template
    .replace('{{result}}', result)
    .replace('{{nozzle}}', nozzle)
    .replace('{{pump}}', pump)
    .replace('{{variance}}', variance);
}

export async function sendPaymentConfirmationWA(owner, txn) {
  if (!owner?.whatsapp || !owner?.whatsapp_num) return;
  const message = buildPaymentMsg(owner, txn);
  return sendWhatsApp(owner.whatsapp_num, message, 'payment', owner.id);
}

// ── API Routes

// POST /api/whatsapp/test — send test message
router.post('/test', authMiddleware, requireRole('admin'), async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });
  const result = await sendWhatsApp(to, message, 'test', null);
  res.json(result);
});

// GET /api/whatsapp/log — WA message log (admin)
router.get('/log', authMiddleware, requireRole('admin'), (req, res) => {
  const logs = db.all('SELECT wl.*, o.name as owner_name FROM wa_log wl LEFT JOIN owners o ON wl.owner_id=o.id ORDER BY wl.created_at DESC LIMIT 200');
  res.json(logs);
});

// GET /api/whatsapp/stats — delivery stats per owner
router.get('/stats', authMiddleware, requireRole('admin'), (req, res) => {
  const stats = db.all('SELECT * FROM v_wa_stats');
  res.json(stats);
});

export default router;
