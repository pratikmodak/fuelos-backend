// services/whatsapp.js — Meta WhatsApp Cloud API
// Uses approved templates for outbound messages (works to any number)
// Falls back to free-text only within 24hr conversation window
const db = require('../db');
const { shiftConfirm, shiftStatus, resolveLang } = require('../wa-messages');

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
    const mid = data?.messages?.[0]?.id;
    console.log(`[WhatsApp] ✓ Template sent to ${to} — id: ${mid}`);
    return { ok: true, messageId: mid };
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
  const to_1 = normalisePhone(toNumber);
  if (to_1.length < 11) return { ok: false, error: 'Invalid number: ' + toNumber };
  console.log(`[WhatsApp] Text → ${to_1}`);
  try {
    const res_1 = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to_1,
        type: 'text',
        text: { body: message, preview_url: false },
      }),
    });
    const data_1 = await res_1.json();
    if (!res_1.ok) {
      const errMsg_1  = data_1?.error?.message || 'Unknown error';
      const errCode_1 = data_1?.error?.code;
      const detail_1  = data_1?.error?.error_data?.details || '';
      return { ok: false, error: `(#${errCode_1}) ${errMsg_1}${detail_1 ? ' — ' + detail_1 : ''}`, code: errCode_1 };
    }
    const mid_1 = data_1?.messages?.[0]?.id;
    console.log(`[WhatsApp] ✓ Text sent to_1 ${to_1} — id: ${mid_1}`);
    return { ok: true, messageId: mid_1 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

// ── Helpers to_1 build template body components
const bodyParams = (...texts) => ([{
  type: 'body',
  parameters: texts.map(t => ({ type: 'text', text: String(t ?? '') })),
}]);

// ── Test connection
const testConnection = async (toNumber) => {
  const cfg_1 = await getWaConfig();
  if (!cfg_1.apiKey)        return { ok: false, step: 'config', error: 'No API key saved.' };
  if (!cfg_1.phoneNumberId) return { ok: false, step: 'config', error: 'No Phone Number ID saved.' };
  const target = toNumber || cfg_1.fromNumber;
  if (!target) return { ok: false, step: 'config', error: 'Provide a test number.' };
  // Try free-text for test (works within 24hr window / test number)
  return sendText(target,
    `✅ *FuelOS WhatsApp Connected!*\n\nYour integration is working correctly.\nSent: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
  );
};

// ── Notify owner when shift submitted
// Tries approved template first, falls back to_1 free-text if template not approved yet
const notifyShiftSubmitted = async (ownerPhone, data_1) => {
  if (!ownerPhone) return { ok: false, error: 'No owner phone' };
  const cfg_2 = await getWaConfig();
  const { pumpName, operator, shift, date, totalRevenue, cash, upi, card } = data_1;
  const r_1 = n => String(Number(n||0).toLocaleString('en-IN'));

  // Try approved template first (works 24/7 without 24hr restriction)
  const tplResult = await sendTemplate(ownerPhone, cfg_2.tplShiftSubmitted, 'en_US',
    bodyParams(pumpName||'Pump', operator||'', shift||'', date||'',
               r_1(totalRevenue), r_1(cash), r_1(upi), r_1(card))
  );
  if (tplResult.ok) return tplResult;

  // Fallback to free-text if template fails
  console.warn('[WhatsApp] Template failed, falling back to text:', tplResult.error);
  const lang = data_1.lang || 'en';
  const msg = lang === 'mr'
    ? [
        `🔔 *${pumpName||'Pump'} — Shift सादर झाली*`,
        `👤 Operator: ${operator||'—'} | Shift: ${shift} | दिनांक: ${date}`,
        `💰 महसूल: ₹${r_1(totalRevenue)}`,
        `💵 Cash: ₹${r_1(cash)} | 📱 UPI: ₹${r_1(upi)} | 💳 Card: ₹${r_1(card)}`,
        `✅ FuelOS मध्ये login करून confirm करा.`,
      ].join('\n')
    : [
        `🔔 *${pumpName||'Pump'} — Shift Submitted*`,
        `👤 Operator: ${operator||'—'} | Shift: ${shift} | Date: ${date}`,
        `💰 Revenue: ₹${r_1(totalRevenue)}`,
        `💵 Cash: ₹${r_1(cash)} | 📱 UPI: ₹${r_1(upi)} | 💳 Card: ₹${r_1(card)}`,
        `✅ Login to FuelOS to confirm.`,
      ].join('\n');
  return sendText(ownerPhone, msg);
};

// ── Notify owner when manager confirms a shift
// Template: fuelos_shift_confirmed
// Params: {{1}}=pumpName {{2}}=operator {{3}}=shift {{4}}=confirmedBy {{5}}=amount
const notifyShiftConfirmed = async (ownerPhone, data_1) => {
  if (!ownerPhone) return { ok: false, error: 'No owner phone' };
  const cfg_3 = await getWaConfig();
  const { pumpName, operator, shift, confirmedBy, amount } = data_1;
  const r_2 = n => String(Number(n||0).toLocaleString('en-IN'));
  const tpl = await sendTemplate(ownerPhone, cfg_3.tplShiftConfirmed, 'en_US',
    bodyParams(pumpName||'Pump', operator||'', shift||'', confirmedBy||'Manager', r_2(amount))
  );
  if (tpl.ok) return tpl;
  console.warn('[WhatsApp] Template failed, falling back to_1 text:', tpl.error);
  const lang_1 = data_1.lang || 'en';
  const msg_1 = lang_1 === 'mr'
    ? [
        `✅ Shift Confirmed — ${pumpName||'Pump'}`,
        `Operator: ${operator} | Shift: ${shift}`,
        `Confirmed by: ${confirmedBy||'Manager'}`,
        `महसूल: ₹${r_2(amount)}`,
      ].join('\n')
    : [
        `✅ Shift Confirmed — ${pumpName||'Pump'}`,
        `Operator: ${operator} | Shift: ${shift}`,
        `Confirmed by: ${confirmedBy||'Manager'}`,
        `Revenue: Rs.${r_2(amount)}`,
      ].join('\n');
  return sendText(ownerPhone, msg_1);
};

// ── Notify owner after successful plan payment
// Template: fuelos_payment_success
// Params: {{1}}=plan {{2}}=billing {{3}}=amount {{4}}=validTill
const notifyPaymentSuccess = async (ownerPhone, data_1) => {
  if (!ownerPhone) return { ok: false, error: 'No owner phone' };
  const cfg_4 = await getWaConfig();
  const { plan, billing, amount, validTill } = data_1;
  const r_3 = n => String(Number(n||0).toLocaleString('en-IN'));
  const tpl_1 = await sendTemplate(ownerPhone, cfg_4.tplPaymentSuccess, 'en_US',
    bodyParams(plan||'', billing||'Monthly', r_3(amount), validTill||'')
  );
  if (tpl_1.ok) return tpl_1;
  console.warn('[WhatsApp] Template failed, falling back to text:', tpl_1.error);
  return sendText(ownerPhone, [
    `💳 Payment Successful — FuelOS`,
    `Plan: ${plan} | Billing: ${billing||'Monthly'}`,
    `Amount: Rs.${r_3(amount)} | Valid till: ${validTill}`,
  ].join('\n'));
};

// ── Low stock alert
// Template: fuelos_low_stock_alert
// Params: {{1}}=pumpName {{2}}=tankName {{3}}=currentStock {{4}}=threshold
const notifyLowStock = async (ownerPhone, data) => {
  if (!ownerPhone) return { ok: false, error: 'No owner phone' };
  const cfg_5 = await getWaConfig();
  const { pumpName, tankName, currentStock, threshold } = data;
  const tpl_2 = await sendTemplate(ownerPhone, cfg_5.tplLowStock, 'en_US',
    bodyParams(pumpName||'Pump', tankName||'Tank',
               String(currentStock||0), String(threshold||0))
  );
  if (tpl_2.ok) return tpl_2;
  console.warn('[WhatsApp] Template failed, falling back to text:', tpl_2.error);
  return sendText(ownerPhone, [
    `⚠️ Low Stock Alert — ${pumpName||'Pump'}`,
    `Tank: ${tankName} | Current: ${currentStock}L | Threshold: ${threshold}L`,
    `Please arrange a refill.`,
  ].join('\n'));
};

module.exports = {
  sendText, sendTemplate, testConnection, getWaConfig,
  notifyShiftSubmitted, notifyShiftConfirmed,
  notifyPaymentSuccess, notifyLowStock,
};