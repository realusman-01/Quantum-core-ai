export const config = {
  runtime: 'nodejs',
  maxDuration: 60
};

const MODEL_MAP = {
  fast: 'gemini-3.5-flash-lite',
  core: 'gemma-4-31b-it',
  fallback: 'gemini-3.5-flash-lite'
};

async function callGemini(modelName, apiKey, geminiBody, isStream = true) {
  const endpoint = isStream 
    ? `streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`
    : `generateContent?key=${encodeURIComponent(apiKey)}`;
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:${endpoint}`;
  
  return await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(geminiBody)
  });
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ 
      error: 'GEMINI_API_KEY not configured in Vercel Environment Variables.' 
    });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { contents, systemInstruction, generationConfig, mode } = body;
  const primaryModel = MODEL_MAP[mode] || MODEL_MAP.fast;
  const geminiBody = { contents, systemInstruction, generationConfig };

  let geminiRes;
  let usedModel = primaryModel;

  try {
    // Step 1: Try primary model (Gemma 4 for Core, Gemini 3.5 for Fast)
    geminiRes = await callGemini(primaryModel, apiKey, geminiBody, true);

    // Step 2: Agar Core mode hai aur 429/503 aaya, toh fallback
    if (!geminiRes.ok && (geminiRes.status === 429 || geminiRes.status === 503) && mode === 'core') {
      console.log(`⚠️ Core (${primaryModel}) failed with ${geminiRes.status}. Falling back to ${MODEL_MAP.fallback}`);
      geminiRes = await callGemini(MODEL_MAP.fallback, apiKey, geminiBody, true);
      usedModel = MODEL_MAP.fallback;
    }

    // Step 3: Agar phir bhi fail, toh error bhejo
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini API error:', geminiRes.status, errText);
      return res.status(geminiRes.status).json({
        error: 'Gemini API error',
        status: geminiRes.status,
        model: usedModel,
        details: errText.substring(0, 500)
      });
    }

    // Step 4: Stream back to frontend
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Model-Used', usedModel);

    const reader = geminiRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(502).json({ error: 'Upstream fetch failed: ' + err.message });
  }
}
