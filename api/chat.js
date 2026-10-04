export const config = {
  runtime: 'nodejs',
  maxDuration: 60
};

const MODEL_CHAIN = {
  fast: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  core: ['gemini-3.6-flash', 'gemini-3.1-flash-lite']
};

// ⚡ Timeout helper
async function fetchWithTimeout(url, options, timeoutMs = 15000) {
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

// 🎯 CRITICAL — Stream chunks one-by-one as they arrive (NO buffering)
async function pipeGeminiStream(geminiRes, res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'none');

  // Flush headers immediately
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const reader = geminiRes.body.getReader();
  const decoder = new TextDecoder('utf-8');

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk) {
        res.write(chunk);
        // Flush if available (helps bypass any buffering proxy)
        if (typeof res.flush === 'function') res.flush();
      }
    }
    // Final flush of any remaining buffer
    const tail = decoder.decode();
    if (tail) res.write(tail);
  } finally {
    try { reader.releaseLock(); } catch (e) {}
  }
  res.end();
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

  // Try each model in the chain until one connects successfully
  for (const modelName of modelChain) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

    try {
      console.log(`⚡ Trying: ${modelName} (elapsed: ${Date.now() - startTime}ms)`);

      const geminiRes = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody)
      }, 15000);

      if (geminiRes.ok) {
        console.log(`✅ Streaming: ${modelName} (elapsed: ${Date.now() - startTime}ms)`);
        res.setHeader('X-Model-Used', modelName);
        // 🔥 STREAM IT — no arrayBuffer(), no buffering
        await pipeGeminiStream(geminiRes, res);
        return;
      } else {
        console.warn(`⚠️ ${modelName} failed: ${geminiRes.status} → trying next...`);
        lastError = new Error(`Model ${modelName} failed: ${geminiRes.status}`);
      }
    } catch (err) {
      console.error(`❌ ${modelName} error: ${err.message} → trying next...`);
      lastError = err;
    }
  }

  // All models failed — send error response (only if headers not yet sent)
  if (!res.headersSent) {
    return res.status(502).json({
      error: 'All models failed. Please try again.',
      details: lastError ? lastError.message : 'Unknown'
    });
  } else {
    try { res.end(); } catch (e) {}
  }
}