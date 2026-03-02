// services/whatsapp.js — Meta WhatsApp Cloud API sender
const db = require('../db');

const getWaConfig = async () => {
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(() => {});
    const r = await db.query(
      "SELECT key, value FROM app_config WHERE key IN ('wa_api_key','wa_phone_number_id','wa_number','wa_provider')"
    );
    const cfg = {};
    r.rows.forEach(row => { cfg[row.key] = row.value; });
    return {
      apiKey:        cfg.wa_api_key         || process.env.WA_API_KEY         || '',
      phoneNumberId: cfg.wa_phone_number_id || process.env.WA_PHONE_NUMBER_ID || '',
      fromNumber:    cfg.wa_number          || process.env.WA_NUMBER          || '',
      provider:      cfg.wa_provider        || 'meta',
    };
  } catch {
    return { apiKey: '', phoneNumberId: '', fromNumber: '', provider: 'meta' };
  }
};

// Send a text message via Meta Cloud API
const sendText = async (toNumber, message) => {
  const { apiKey, phoneNumberId } = await getWaConfig();
  if (!apiKey || !phoneNumberId) {
    return { ok: false, error: 'WhatsApp not configured — missing API key or Phone Number ID' };
  }
  const to = String(toNumber).replace(/\D/g, '');
  if (to.length < 10) return { ok: false, error: 'Invalid number: ' + toNumber };
  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: message, preview_url: false },
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      const errMsg = data?.error?.message || JSON.stringify(data);
      console.error('[WhatsApp] Send failed:', errMsg);
      return { ok: false, error: errMsg, code: data?.error?.code };
    }
    const messageId = data?.messages?.[0]?.id;
    console.log(`[WhatsApp] ✓ Sent to ${to} — id: ${messageId}`);
    return { ok: true, messageId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

// Test connection — verifies API key + phone number ID work
const testConnection = async (toNumber) => {
  const cfg = await getWaConfig();
  if (!cfg.apiKey)        return { ok: false, step: 'config', error: 'No API key saved. Save credentials in Admin → Integrations → WhatsApp first.' };
  if (!cfg.phoneNumberId) return { ok: false, step: 'config', error: 'No Phone Number ID saved.' };
  const target = toNumber || cfg.fromNumber;
  if (!target) return { ok: false, step: 'config', error: 'Provide a test number or save your Business Phone Number.' };
  return sendText(target, `✅ *FuelOS WhatsApp Connected!*\n\nYour integration is working.\nSent: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
};

// Notify owner when operator submits a shift
const notifyShiftSubmitted = async (ownerPhone, data) => {
  if (!ownerPhone) return { ok: false, error: 'No owner phone' };
  const { operator, shift, pumpName, date, totalRevenue, cash, upi, card, petrolVol, dieselVol } = data;
  const fmt  = n => '₹' + Number(n||0).toLocaleString('en-IN');
  const fmtL = n => Number(n||0).toFixed(1) + 'L';
  const lines = [
    `📋 *Shift Submitted — ${pumpName || 'Pump'}*`,
    ``,
    `👤 Operator: *${operator}*`,
    `⏰ Shift: *${shift}* · ${date}`,
    ``,
    `💰 *Revenue: ${fmt(totalRevenue)}*`,
    `Cash: ${fmt(cash)}  UPI: ${fmt(upi)}  Card: ${fmt(card)}`,
    petrolVol > 0 ? `⛽ Petrol sold: ${fmtL(petrolVol)}` : null,
    dieselVol > 0 ? `🛢 Diesel sold: ${fmtL(dieselVol)}` : null,
    ``,
    `_Open FuelOS to confirm this shift._`,
  ].filter(l => l !== null).join('\n');
  return sendText(ownerPhone, lines);
};

module.exports = { sendText, testConnection, notifyShiftSubmitted, getWaConfig };
