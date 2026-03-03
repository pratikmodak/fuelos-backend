// services/whatsapp.js — Meta WhatsApp Cloud API
// Uses approved templates for outbound messages (works to any number)
// Falls back to free-text only within 24hr conversation window
const db = require('../db');

const getWaConfig = async () => {
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(() => {});
    const r = await db.query(
      `SELECT key, value FROM app_config WHERE key IN (
        'wa_api_key','wa_phone_number_id','wa_number','wa_provider',
        'wa_tpl_shift_submitted','wa_tpl_shift_confirmed',
        'wa_tpl_payment_success','wa_tpl_low_stock'
      )`
    );
    const cfg = {};
    r.rows.forEach(row => { cfg[row.key] = row.value; });
    return {
      apiKey:        cfg.wa_api_key         || process.env.WA_API_KEY         || '',
      phoneNumberId: cfg.wa_phone_number_id || process.env.WA_PHONE_NUMBER_ID || '',
      fromNumber:    cfg.wa_number          || process.env.WA_NUMBER          || '',
      provider:      cfg.wa_provider        || 'meta',
      // Template names saved by admin (default to standard names)
      tplShiftSubmitted:  cfg.wa_tpl_shift_submitted  || 'fuelos_shift_submitted',
      tplShiftConfirmed:  cfg.wa_tpl_shift_confirmed  || 'fuelos_shift_confirmed',
      tplPaymentSuccess:  cfg.wa_tpl_payment_success  || 'fuelos_payment_success',
      tplLowStock:        cfg.wa_tpl_low_stock        || 'fuelos_low_stock_alert',
    };
  } catch {
    return { apiKey: '', phoneNumberId: '', fromNumber: '', provider: 'meta' };
  }
};

// Normalise phone → E.164 digits only
const normalisePhone = (num) => {
  let n = String(num || '').replace(/\D/g, '');
  if (n.length === 10) n = '91' + n;
  return n;
};

// Low-level: send a template message
const sendTemplate = async (toNumber, templateName, langCode, components) => {
  const { apiKey, phoneNumberId } = await getWaConfig();
  if (!apiKey || !phoneNumberId) {
    return { ok: false, error: 'WhatsApp not configured' };
  }
  const to = normalisePhone(toNumber);
  if (to.length < 11) return { ok: false, error: 'Invalid number: ' + toNumber };

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: langCode || 'en_US' },
      ...(components && components.length > 0 ? { components } : {}),
    },
  };

  console.log(`[WhatsApp] Template "${templateName}" → ${to}`);
  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      const errMsg  = data?.error?.message || 'Unknown error';
      const errCode = data?.error?.code;
      const detail  = data?.error?.error_data?.details || '';
      console.error('[WhatsApp] Template failed:', errCode, errMsg, detail);
      return { ok: false, error: `(#${errCode}) ${errMsg}${detail ? ' — ' + detail : ''}`, code: errCode };
    }
    return { ok: true, messageId: data?.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

// Low-level: send a free-text message (only works within 24hr conversation window)
const sendText = async (toNumber, message) => {
  const { apiKey, phoneNumberId } = await getWaConfig();
  if (!apiKey || !phoneNumberId) {
    return { ok: false, error: 'WhatsApp not configured' };
  }
  const to = normalisePhone(toNumber);
  if (to.length < 11) return { ok: false, error: 'Invalid number: ' + toNumber };
  console.log(`[WhatsApp] Text → ${to}`);
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
      const errMsg  = data?.error?.message || 'Unknown error';
      const errCode = data?.error?.code;
      const detail  = data?.error?.error_data?.details || '';
      return { ok: false, error: `(#${errCode}) ${errMsg}${detail ? ' — ' + detail : ''}`, code: errCode };
    }
    return { ok: true, messageId: data?.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

// ── Helpers to build template body components
const bodyParams = (...texts) => ([{
  type: 'body',
  parameters: texts.map(t => ({ type: 'text', text: String(t ?? '') })),
}]);

// ── Test connection
const testConnection = async (toNumber) => {
  const cfg = await getWaConfig();
  if (!cfg.apiKey)        return { ok: false, step: 'config', error: 'No API key saved.' };
  if (!cfg.phoneNumberId) return { ok: false, step: 'config', error: 'No Phone Number ID saved.' };
  const target = toNumber || cfg.fromNumber;
  if (!target) return { ok: false, step: 'config', error: 'Provide a test number.' };
  // Try free-text for test (works within 24hr window / test number)
  return sendText(target,
    `✅ *FuelOS WhatsApp Connected!*\n\nYour integration is working correctly.\nSent: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
  );
};

// ── Notify owner when shift submitted
// Template: fuelos_shift_submitted
// Params: {{1}}=pumpName {{2}}=operator {{3}}=shift {{4}}=date
//         {{5}}=totalRevenue {{6}}=cash {{7}}=upi {{8}}=card
const notifyShiftSubmitted = async (ownerPhone, data) => {
  if (!ownerPhone) return { ok: false, error: 'No owner phone' };
  const cfg = await getWaConfig();
  const { pumpName, operator, shift, date, totalRevenue, cash, upi, card } = data;
  const r = n => String(Number(n||0).toLocaleString('en-IN'));
  return sendTemplate(ownerPhone, cfg.tplShiftSubmitted, 'en_US',
    bodyParams(pumpName||'Pump', operator||'', shift||'', date||'',
               r(totalRevenue), r(cash), r(upi), r(card))
  );
};

// ── Notify owner when manager confirms a shift
// Template: fuelos_shift_confirmed
// Params: {{1}}=pumpName {{2}}=operator {{3}}=shift {{4}}=confirmedBy {{5}}=amount
const notifyShiftConfirmed = async (ownerPhone, data) => {
  if (!ownerPhone) return { ok: false, error: 'No owner phone' };
  const cfg = await getWaConfig();
  const { pumpName, operator, shift, confirmedBy, amount } = data;
  const r = n => String(Number(n||0).toLocaleString('en-IN'));
  return sendTemplate(ownerPhone, cfg.tplShiftConfirmed, 'en_US',
    bodyParams(pumpName||'Pump', operator||'', shift||'', confirmedBy||'Manager', r(amount))
  );
};

// ── Notify owner after successful plan payment
// Template: fuelos_payment_success
// Params: {{1}}=plan {{2}}=billing {{3}}=amount {{4}}=validTill
const notifyPaymentSuccess = async (ownerPhone, data) => {
  if (!ownerPhone) return { ok: false, error: 'No owner phone' };
  const cfg = await getWaConfig();
  const { plan, billing, amount, validTill } = data;
  const r = n => String(Number(n||0).toLocaleString('en-IN'));
  return sendTemplate(ownerPhone, cfg.tplPaymentSuccess, 'en_US',
    bodyParams(plan||'', billing||'Monthly', r(amount), validTill||'')
  );
};

// ── Low stock alert
// Template: fuelos_low_stock_alert
// Params: {{1}}=pumpName {{2}}=tankName {{3}}=currentStock {{4}}=threshold
const notifyLowStock = async (ownerPhone, data) => {
  if (!ownerPhone) return { ok: false, error: 'No owner phone' };
  const cfg = await getWaConfig();
  const { pumpName, tankName, currentStock, threshold } = data;
  return sendTemplate(ownerPhone, cfg.tplLowStock, 'en_US',
    bodyParams(pumpName||'Pump', tankName||'Tank',
               String(currentStock||0), String(threshold||0))
  );
};

module.exports = {
  sendText, sendTemplate, testConnection, getWaConfig,
  notifyShiftSubmitted, notifyShiftConfirmed,
  notifyPaymentSuccess, notifyLowStock,
};