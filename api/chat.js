export const config = {
  runtime: 'nodejs',
  maxDuration: 60
};

const MODEL_MAP = {
  fast: 'gemini-3.5-flash-lite',
  core: 'gemini-3.6-flash'
};

async function fetchWithRetry(url, options, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) {
        return response;
      }
      if (response.status === 503 || response.status === 429) {
        lastError = new Error(`Attempt ${attempt + 1} failed: ${response.status}`);
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(`Retrying in ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      const waitTime = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  throw lastError;
}

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
    return res.status(500).json({ 
      error: 'Server API key not configured. Add GEMINI_API_KEY in Vercel Environment Variables.' 
    });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { contents, systemInstruction, generationConfig, mode } = body;
  const modelName = MODEL_MAP[mode] || MODEL_MAP.fast;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  try {
    const geminiRes = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, systemInstruction, generationConfig })
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini API error:', geminiRes.status, errText);
      return res.status(geminiRes.status).send(errText);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

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
