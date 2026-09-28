export const config = {
  runtime: 'nodejs',
  maxDuration: 30
};

const MODEL_MAP = {
  fast: 'gemini-3.5-flash-lite',
  core: 'gemma-4-31b-it',
  fallback: 'gemini-3.5-flash-lite'
};

async function callGemini(modelName, apiKey, geminiBody) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;
  return await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(geminiBody)
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { prompt, mode } = body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const primaryModel = MODEL_MAP[mode] || MODEL_MAP.fast;
  const geminiBody = {
    contents: [{
      parts: [{
        text: 'Summarize this into a short 2-5 word chat title without punctuation: ' + prompt
      }]
    }]
  };

  try {
    let geminiRes = await callGemini(primaryModel, apiKey, geminiBody);

    // Fallback for core mode
    if (!geminiRes.ok && (geminiRes.status === 429 || geminiRes.status === 503) && mode === 'core') {
      console.log(`Title: Core failed with ${geminiRes.status}, falling back`);
      geminiRes = await callGemini(MODEL_MAP.fallback, apiKey, geminiBody);
    }

    const data = await geminiRes.text();
    return res.status(geminiRes.status).send(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
