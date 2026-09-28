export const config = {
  runtime: 'nodejs',
  maxDuration: 30
};

const MODEL_MAP = {
  fast: 'gemini-3.5-flash-lite',
  core: 'gemini-3.6-flash'
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server API key not configured' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { prompt, mode } = body;
  if (!prompt) {
    return res.status(400).json({ error: 'prompt required' });
  }

  const modelName = MODEL_MAP[mode] || MODEL_MAP.fast;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: 'Summarize this into a short 2-5 word chat title without punctuation: ' + prompt
          }]
        }]
      })
    });

    const data = await geminiRes.text();
    return res.status(geminiRes.status).send(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
