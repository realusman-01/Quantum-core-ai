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

function needsWebSearch(contents) {
  const text = (contents || []).map(m => (m.parts || []).map(p => p.text || '').join(' ')).join('\n').toLowerCase();
  const triggers = [
    'today', 'todays', 'today\'s', 'current', 'currently', 'right now', 'latest', 'recent',
    'news', 'this week', 'this month', 'this year', '2026', '2025', 'price', 'weather',
    'president', 'prime minister', 'ceo', 'who is the current', 'what is happening',
    'score', 'standings', 'release date', 'new update', 'latest update'
  ];
  return triggers.some(t => text.includes(t));
}

function getLastUserText(contents) {
  for (let i = (contents || []).length - 1; i >= 0; i--) {
    if (contents[i]?.role === 'user') {
      return (contents[i].parts || []).map(p => p.text || '').join(' ').trim();
    }
  }
  return '';
}

function sseEvent(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function tavilySearch(query) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return { results: [], error: 'TAVILY_API_KEY not configured' };
  const res = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      query,
      search_depth: 'basic',
      topic: 'general',
      max_results: 5,
      include_answer: false,
      include_raw_content: false
    })
  }, 10000);
  if (!res.ok) throw new Error(`Tavily failed: ${res.status}`);
  const data = await res.json();
  return { results: Array.isArray(data.results) ? data.results : [] };
}

function buildWebContext(results) {
  if (!results.length) return '';
  return results.map((r, i) =>
    `[Source ${i + 1}] ${r.title || 'Untitled'}\nURL: ${r.url || ''}\nContent: ${r.content || ''}`
  ).join('\n\n');
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
  const currentDate = new Date();
  const dateText = currentDate.toISOString();
  const userQuery = getLastUserText(contents);
  const searchNeeded = needsWebSearch(contents);

  let webContext = '';
  let searchError = null;
  let searchResults = [];

  if (searchNeeded && userQuery) {
    try {
      searchResults = (await tavilySearch(userQuery)).results;
      webContext = buildWebContext(searchResults);
    } catch (err) {
      searchError = err.message;
      console.error('Tavily error:', err.message);
    }
  }

  const liveInstruction = `\n\n=== LIVE DATE/TIME ===\nThe server's current date/time is ${dateText}. Treat this as authoritative for questions about today's date, current month, current year, or relative dates. Never invent an older date.\n\n=== WEB SEARCH ===\n${searchNeeded && webContext ? 'Fresh web sources were retrieved. Use them for current/fresh claims. Cite sources inline as [Source 1], [Source 2], etc. Do not claim you searched if no sources are present.' : 'No web search was needed for this request.'}\n${webContext ? '\nWEB SOURCES:\n' + webContext : ''}\n${searchError ? '\nSearch failed; answer from available knowledge and clearly avoid pretending the information is live. Search error: ' + searchError : ''}`;

  const combinedInstruction = (systemInstruction?.parts?.map(p => p.text || '').join('\n') || '') + liveInstruction;
  const geminiBody = {
    contents,
    systemInstruction: { parts: [{ text: combinedInstruction }] },
    generationConfig
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = obj => controller.enqueue(encoder.encode(sseEvent(obj)));
      try {
        send({ type: 'status', status: searchNeeded ? '🧠 Thinking... → 🌐 Searching the web...' : '🧠 Thinking...' });
        if (searchNeeded) send({ type: 'status', status: searchResults.length ? '🔎 Checking sources... → 🧠 Analyzing...' : '🔎 Search unavailable → 🧠 Using available knowledge...' });
        send({ type: 'status', status: '✍️ Writing answer...' });

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
              const reader = geminiRes.body.getReader();
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
              controller.close();
              return;
            }
            lastError = new Error(`Model ${modelName} failed: ${geminiRes.status}`);
          } catch (err) {
            lastError = err;
          }
        }
        send({ error: 'All models failed. Please try again.', details: lastError?.message || 'Unknown' });
        controller.close();
      } catch (err) {
        try { send({ error: err.message || 'Server error' }); } catch (_) {}
        controller.close();
      }
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}
