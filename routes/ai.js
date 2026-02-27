// routes/ai.js — AI endpoints (Claude API via backend to protect API key)
const router  = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');

// POST /api/ai/insight — Claude shift analysis
router.post('/insight', requireAuth, async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: 'AI not configured. Add ANTHROPIC_API_KEY to Render env vars.' });

  try {
    const { pump, date, shifts, totalRevenue, avgRevenue, variance, topOperator, lowStock } = req.body;

    const prompt = `You are FuelOS AI, a fuel station analytics assistant for India. Analyze this shift data and give a brief, actionable insight in 2-3 sentences. Use ₹ for currency and Indian number format.

Pump: ${pump}
Date: ${date}
Shifts submitted: ${shifts}/3
Today's revenue: ₹${Number(totalRevenue||0).toLocaleString('en-IN')}
30-day average: ₹${Number(avgRevenue||0).toLocaleString('en-IN')}
vs average: ${variance > 0 ? '+' : ''}${variance}%
Top operator: ${topOperator || 'N/A'}
Low stock: ${(lowStock||[]).join(', ') || 'None'}

Give:
1. Performance summary (1 sentence)
2. Key concern or positive (1 sentence)  
3. One recommended action (1 sentence)

Max 80 words. Be direct and specific.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',  // Fast + cheap for insights
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `Anthropic API ${response.status}`);
    }

    const data = await response.json();
    const text = data.content?.find(b => b.type === 'text')?.text || '';
    res.json({ ok: true, insight: text });
  } catch (e) {
    console.error('[ai/insight]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/ai/market-summary — natural language market price explanation
router.post('/market-summary', requireAuth, async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: 'AI not configured' });

  try {
    const { city, petrol, diesel, cng, prevPetrol, prevDiesel } = req.body;
    const prompt = `Petrol in ${city}: ₹${petrol}/L, Diesel: ₹${diesel}/L${cng ? `, CNG: ₹${cng}/kg` : ''}${prevPetrol ? `. Previous petrol: ₹${prevPetrol}/L` : ''}. Write one sentence telling the station owner whether they should update their pump rates today and why.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 80, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    const text = data.content?.find(b => b.type === 'text')?.text || '';
    res.json({ ok: true, summary: text });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
