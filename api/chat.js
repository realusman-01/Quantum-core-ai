export const config = {
  runtime: 'nodejs',
  maxDuration: 60
};

// Fallback Chain: Pehle best model, phir stable models
const MODEL_CHAIN = {
  fast: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash'],
  core: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash']
};

async function fetchWithRetry(url, options, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      
      // Agar 503 (busy) ya 429 (quota) aaye toh retry karo
      if (response.status === 503 || response.status === 429) {
        lastError = new Error(`Attempt ${attempt + 1} failed: ${response.status}`);
        // Exponential backoff: 1s, 2s wait
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      return response; // Doosre errors ke liye turant return karo
    } catch (err) {
      lastError = err;
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
  throw lastError;
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

  // Har model ko ek-ek karke try karo
  for (const modelName of modelChain) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
    
    try {
      console.log(`Trying model: ${modelName}`);
      const geminiRes = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody)
      });

      if (geminiRes.ok) {
        console.log(`✅ Success with model: ${modelName}`);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('X-Model-Used', modelName);

        const buffer = await geminiRes.arrayBuffer();
        res.write(Buffer.from(new Uint8Array(buffer)));
        return res.end();
      } else {
        console.warn(`⚠️ Model ${modelName} failed with status ${geminiRes.status}`);
        lastError = new Error(`Model ${modelName} failed: ${geminiRes.status}`);
      }
    } catch (err) {
      console.error(`❌ Model ${modelName} threw error:`, err.message);
      lastError = err;
    }
  }

  // Agar saare models fail ho jayein
  console.error('All models in the chain failed.');
  return res.status(502).json({ 
    error: 'All models failed. Please try again later.',
    details: lastError ? lastError.message : 'Unknown error'
  });
}
