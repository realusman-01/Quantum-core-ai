export const config = { runtime: 'edge' };

const MODEL_CHAIN = {
  fast: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  core: ['gemini-3.6-flash', 'gemini-3.1-flash-lite']
};

const PLANNER_CHAIN = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

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

function sseEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractTextFromGemini(json) {
  return json?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('') || '';
}

async function decideSearch(contents, apiKey) {
  const recent = contents.slice(-8);
  const plannerPrompt = `You are Quantum Core's web-search decision engine.\n\nDecide whether the user's latest request needs current/external web information. Search when the answer depends on current news, latest information, live/current prices, current product/service details, recent events, current sports/weather, named websites/pages, or facts you cannot reliably answer from stable knowledge. Do NOT search for ordinary conversation, writing/rewriting, coding that does not require current docs, school explanations, math, physics, or stable general knowledge.\n\nReturn ONLY valid JSON, no markdown:\n{"search":true|false,"query":"short precise search query"}\n\nConversation:\n${JSON.stringify(recent)}`;

  let lastError = null;
  for (const modelName of PLANNER_CHAIN) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: plannerPrompt }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' }
        })
      }, 10000);
      if (!res.ok) {
        lastError = new Error(`Planner ${modelName} failed: ${res.status}`);
        continue;
      }
      const json = await res.json();
      const raw = extractTextFromGemini(json).trim();
      try {
        const parsed = JSON.parse(raw);
        return { search: Boolean(parsed.search), query: cleanText(parsed.query) };
      } catch {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          return { search: Boolean(parsed.search), query: cleanText(parsed.query) };
        }
      }
      lastError = new Error('Planner returned invalid JSON');
    } catch (err) {
      lastError = err;
    }
  }
  console.warn('Search planner failed:', lastError?.message || 'unknown');
  return { search: false, query: '' };
}

async function tavilySearch(query) {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) return { results: [], error: 'TAVILY_API_KEY not configured' };
  if (!query) return { results: [], error: 'Empty search query' };

  try {
    const res = await fetchWithTimeout('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query,
        search_depth: 'basic',
        topic: 'general',
        max_results: 6,
        include_answer: false,
        include_raw_content: false,
        include_images: false
      })
    }, 10000);
    if (!res.ok) {
      const text = await res.text();
      return { results: [], error: `Tavily ${res.status}: ${text.slice(0, 200)}` };
    }
    const json = await res.json();
    const results = Array.isArray(json.results) ? json.results.slice(0, 6).map((r, i) => ({
      id: i + 1,
      title: cleanText(r.title),
      url: r.url,
      content: cleanText(r.content)
    })) : [];
    return { results, error: null };
  } catch (err) {
    return { results: [], error: err.message || 'Tavily request failed' };
  }
}

function buildSearchContext(results) {
  if (!results.length) return '';
  return `\n\n=== LIVE WEB SEARCH RESULTS ===\nThe following results were retrieved just now. Use them as evidence, but do not blindly trust them. When making factual claims based on a source, cite it inline using the exact format [Source N]. At the end add a short **Sources** section listing each used source as [Source N](URL). Never invent URLs or sources.\n\n${results.map(r => `[Source ${r.id}] ${r.title}\nURL: ${r.url}\nSnippet: ${r.content}`).join('\n\n')}`;
}

async function streamGemini({ contents, systemInstruction, generationConfig, modelChain, signal, onModel }) {
  let lastError = null;
  for (const modelName of modelChain) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
    try {
      onModel?.(modelName);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, systemInstruction, generationConfig }),
        signal
      });
      if (res.ok) return { response: res, modelName };
      lastError = new Error(`Model ${modelName} failed: ${res.status}`);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastError = err;
    }
  }
  throw lastError || new Error('All models failed');
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS_HEADERS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }

  const { contents, systemInstruction, generationConfig, mode } = body;
  const modelChain = MODEL_CHAIN[mode] || MODEL_CHAIN.fast;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 55000);

  const stream = new ReadableStream({
    async start(controller) {
      const send = (type, payload) => controller.enqueue(encoder.encode(sseEvent(type, payload)));
      try {
        send('qc_status', { status: 'thinking', message: 'Thinking...' });

        const decision = await decideSearch(contents || [], apiKey);
        let searchResults = [];

        if (decision.search && process.env.TAVILY_API_KEY) {
          send('qc_status', { status: 'searching', message: 'Searching the web...', query: decision.query });
          const search = await tavilySearch(decision.query);
          searchResults = search.results;
          if (search.error) console.warn(search.error);
          if (searchResults.length) send('qc_status', { status: 'checking', message: 'Checking sources...', count: searchResults.length });
        } else if (decision.search && !process.env.TAVILY_API_KEY) {
          console.warn('Search requested but TAVILY_API_KEY is missing.');
        }

        if (searchResults.length) send('qc_status', { status: 'analyzing', message: 'Analyzing sources...' });
        send('qc_status', { status: 'writing', message: 'Writing answer...' });

        const searchContext = buildSearchContext(searchResults);
        const finalSystem = (systemInstruction?.parts?.map(p => p.text || '').join('\n') || '') + searchContext;
        const finalInstruction = { parts: [{ text: finalSystem }] };

        const gemini = await streamGemini({
          contents,
          systemInstruction: finalInstruction,
          generationConfig,
          modelChain,
          signal: abortController.signal,
          onModel: modelName => send('qc_meta', { model: modelName, searched: searchResults.length > 0 })
        });

        const reader = gemini.response.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        send('qc_done', { searched: searchResults.length > 0, sources: searchResults.map(r => ({ id: r.id, title: r.title, url: r.url })) });
        controller.close();
      } catch (err) {
        console.error('Quantum Core chat error:', err);
        if (err.name === 'AbortError') {
          send('qc_error', { error: 'Request timed out. Please try again.' });
        } else {
          send('qc_error', { error: err.message || 'All models failed.' });
        }
        controller.close();
      } finally {
        clearTimeout(timeoutId);
      }
    },
    cancel() { abortController.abort(); clearTimeout(timeoutId); }
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
