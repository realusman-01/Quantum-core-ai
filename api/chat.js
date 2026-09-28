export const config = {
  runtime: 'nodejs',
  maxDuration: 60
};

const MODEL_CHAIN = {
  fast: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  core: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']
};

// ⚡ Timeout helper - agar 8 second mein jawab nahi, toh cancel
async function fetchWithTimeout(url, options, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
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
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { contents, systemInstruction, generationConfig, mode } = body;
  const modelChain = MODEL_CHAIN[mode] || MODEL_CHAIN.fast;
  const geminiBody = { contents, systemInstruction, generationConfig };

  let lastError = null;
  const startTime = Date.now();

  // ⚡ Har model ko ek hi baar try karo - no retries, no waiting
  for (const modelName of modelChain) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
    
    try {
      console.log(`⚡ Trying: ${modelName} (elapsed: ${Date.now() - startTime}ms)`);
      
      const geminiRes = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody)
      }, 8000);

      if (geminiRes.ok) {
        console.log(`✅ Success: ${modelName} (elapsed: ${Date.now() - startTime}ms)`);
        
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('X-Model-Used', modelName);

        const buffer = await geminiRes.arrayBuffer();
        res.write(Buffer.from(new Uint8Array(buffer)));
        return res.end();
      } else {
        // 503/429 ya koi bhi fail → turant agla model, koi wait nahi
        console.warn(`⚠️ ${modelName} failed: ${geminiRes.status} → trying next...`);
        lastError = new Error(`Model ${modelName} failed: ${geminiRes.status}`);
      }
    } catch (err) {
      // Timeout ya network error → turant agla model
      console.error(`❌ ${modelName} error: ${err.message} → trying next...`);
      lastError = err;
    }
  }

  // Sab fail ho gaye toh ek chhota wait + ek final retry
  console.log(`🔄 All models failed, waiting 2s for one final retry...`);
  await new Promise(r => setTimeout(r, 2000));

  const primaryModel = modelChain[0];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${primaryModel}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  try {
    const finalRes = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody)
    }, 15000);

    if (finalRes.ok) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const buffer = await finalRes.arrayBuffer();
      res.write(Buffer.from(new Uint8Array(buffer)));
      return res.end();
    }
  } catch (err) {
    lastError = err;
  }

  return res.status(502).json({
    error: 'All models failed. Please try again.',
    details: lastError ? lastError.message : 'Unknown'
  });
}
