// ═══════════════════════════════════════════════════════════════════
// FuelOS v3 — WhatsApp Message Templates (Bilingual: English + Marathi)
// Scope: Staff follow-up | Credit notifications | Shift notifications
// Language is set per individual manager/operator (lang_pref field)
// ═══════════════════════════════════════════════════════════════════

// ── Staff follow-up (sent to manager or operator) ─────────────────
const staffFollowup = (staff, ownerName, lang = 'en') => {
  if (lang === 'mr') {
    return [
      `नमस्कार ${staff.name},`,
      '',
      `हे ${ownerName || 'FuelOS'} कडून एक महत्त्वाचे संदेश आहे.`,
      '',
      'आम्हाला आढळले की तुम्ही अलीकडे FuelOS वर shift नोंदवलेली नाही.',
      'कृपया FuelOS मध्ये login करा आणि तुमचा shift report सादर करा.',
      'काही अडचण असल्यास तुमच्या owner शी संपर्क करा.',
      '',
      'धन्यवाद! 🙏',
    ].join('\n');
  }
  return [
    `Hi ${staff.name},`,
    '',
    `This is an important message from ${ownerName || 'FuelOS'}.`,
    '',
    "We noticed you haven't recorded a shift on FuelOS recently.",
    'Please log in to FuelOS and submit your shift report.',
    'Contact your owner if you need any help.',
    '',
    'Thank you! 🙏',
  ].join('\n');
};

// ── Credit purchase notification (sent to customer via owner WA) ──
const creditPurchase = (customerName, amount, fuel, qty, outstanding, lang = 'en') => {
  if (lang === 'mr') {
    return [
      `नमस्कार ${customerName},`,
      '',
      `तुम्ही *₹${amount}* चे ${fuel} (${qty}L) उधारीवर घेतले आहे.`,
      `सध्याची एकूण थकबाकी: *₹${outstanding}*`,
      '',
      'वेळेत पेमेंट करा. धन्यवाद! 🙏',
    ].join('\n');
  }
  return [
    `Hi ${customerName},`,
    '',
    `You have taken *₹${amount}* worth of ${fuel} (${qty}L) on credit.`,
    `Total outstanding: *₹${outstanding}*`,
    '',
    'Please pay on time. Thank you! 🙏',
  ].join('\n');
};

// ── Credit collection receipt ─────────────────────────────────────
const creditCollect = (customerName, amount, remaining, lang = 'en') => {
  if (lang === 'mr') {
    return [
      `नमस्कार ${customerName},`,
      '',
      `तुमची *₹${amount}* ची पेमेंट मिळाली. ✅`,
      `राहिलेली थकबाकी: *₹${remaining}*`,
      '',
      'धन्यवाद! 🙏',
    ].join('\n');
  }
  return [
    `Hi ${customerName},`,
    '',
    `Payment of *₹${amount}* received. ✅`,
    `Remaining outstanding: *₹${remaining}*`,
    '',
    'Thank you! 🙏',
  ].join('\n');
};

// ── Shift submitted confirmation (sent to operator) ───────────────
const shiftConfirm = (operatorName, shift, date, lang = 'en') => {
  if (lang === 'mr') {
    return [
      `नमस्कार ${operatorName},`,
      `*${date}* च्या *${shift}* shift साठी तुमचा report यशस्वीरित्या सादर झाला. ✅`,
      'चांगले काम! 👍',
    ].join('\n');
  }
  return [
    `Hi ${operatorName},`,
    `Your *${shift}* shift report for *${date}* has been submitted successfully. ✅`,
    'Great work! 👍',
  ].join('\n');
};

// ── Shift confirmed/rejected by owner (sent to operator) ─────────
const shiftStatus = (operatorName, shift, date, status, note, lang = 'en') => {
  const approved = status === 'Approved' || status === 'confirmed';
  if (lang === 'mr') {
    return [
      `नमस्कार ${operatorName},`,
      `*${date}* च्या *${shift}* shift ला *${approved ? 'मंजुरी मिळाली ✅' : 'नाकारण्यात आले ❌'}*.`,
      note ? `टीप: ${note}` : '',
    ].filter(Boolean).join('\n');
  }
  return [
    `Hi ${operatorName},`,
    `Your *${shift}* shift for *${date}* has been *${approved ? 'approved ✅' : 'rejected ❌'}*.`,
    note ? `Note: ${note}` : '',
  ].filter(Boolean).join('\n');
};

// ── Helper: resolve lang from staff row ───────────────────────────
// Falls back to 'en' if not set
const resolveLang = (staffRow) => staffRow?.lang_pref || 'en';

module.exports = {
  staffFollowup,
  creditPurchase,
  creditCollect,
  shiftConfirm,
  shiftStatus,
  resolveLang,
};