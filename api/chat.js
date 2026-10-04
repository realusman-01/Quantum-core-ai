export const config = {
  runtime: 'edge'
};

const MODEL_CHAIN = {
  fast: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  core: ['gemini-3.6-flash', 'gemini-3.1-flash-lite']
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

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

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  let body;
  try { body = await req.json(); }
  catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  const { contents, systemInstruction, generationConfig, mode } = body;
  const modelChain = MODEL_CHAIN[mode] || MODEL_CHAIN.fast;
  const geminiBody = { contents, systemInstruction, generationConfig };

  let lastError = null;
  const startTime = Date.now();

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
        return new Response(geminiRes.body, {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'X-Model-Used': modelName
          }
        });
      } else {
        console.warn(`⚠️ ${modelName} failed: ${geminiRes.status} → trying next...`);
        lastError = new Error(`Model ${modelName} failed: ${geminiRes.status}`);
      }
    } catch (err) {
      console.error(`❌ ${modelName} error: ${err.message} → trying next...`);
      lastError = err;
    }
  }

  return new Response(JSON.stringify({
    error: 'All models failed. Please try again.',
    details: lastError ? lastError.message : 'Unknown'
  }), {
    status: 502,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}