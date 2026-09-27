export const config = { runtime: 'edge' };

// Yahan model IDs change kar sakte ho (agar future mein update ho)
const MODEL_MAP = {
  fast: 'gemini-3.5-flash-lite',
  core: 'gemini-3.6-flash'
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'Server API key not configured. Add GEMINI_API_KEY in Vercel Environment Variables.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { contents, systemInstruction, generationConfig, mode } = body;
  const modelName = MODEL_MAP[mode] || MODEL_MAP.fast;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  try {
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, systemInstruction, generationConfig })
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return new Response(errText, {
        status: geminiRes.status,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Stream ko seedha frontend tak pass karo (SSE)
    return new Response(geminiRes.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Upstream fetch failed: ' + err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
