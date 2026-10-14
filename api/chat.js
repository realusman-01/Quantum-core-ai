export const config = {
  runtime: 'edge'
};

/* =========================================================
   RADOX AI (Primary) + GEMINI (Fallback)
   ========================================================= */

const RADOX_API = 'https://radoxai.com/v1/chat/completions';

const RADOX_MODELS = {
  fast: ['gemini-3.6-flash', 'gpt-5.5', 'deepseek-v4-flash-0731', 'gemma-2-2b'],
  core: ['claude-opus-5.5', 'gpt-5.6-sol', 'deepseek-v4-pro-max', 'claude-opus-5']
};

const RADOX_DECISION_MODEL = 'gemini-3.6-flash';

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/';
const GEMINI_MODEL_CHAIN = {
  fast: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  core: ['gemini-3.6-flash', 'gemini-3.5-flash-lite']
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

/* =========================================================
   BASIC HELPERS
   ========================================================= */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

function sseEvent(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

async function fetchWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   EXTRACT USER TEXT + MEMORY
   ========================================================= */

function getLatestUserText(contents) {
  if (!Array.isArray(contents)) return '';
  for (let i = contents.length - 1; i >= 0; i--) {
    const m = contents[i];
    if (m && m.role === 'user' && Array.isArray(m.parts)) {
      const text = m.parts.map(p => (typeof p?.text === 'string' ? p.text : '')).join(' ').trim();
      if (text) return text;
    }
  }
  return '';
}

async function fetchMemories(userId, userText) {
  if (!userId || !process.env.SUPABASE_URL) return [];
  try {
    const url = `${process.env.SUPABASE_URL}/rest/v1/memories?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=50`;
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`
      }
    }, 6000);
    if (!response.ok) return [];
    const memories = await response.json();
    if (!Array.isArray(memories)) return [];

    const text = String(userText || '').toLowerCase();
    const words = text.split(/\s+/).filter(w => w.length >= 4);

    const scored = memories.map(memory => {
      const searchable = [memory.key, memory.value, memory.category, memory.content, memory.type]
        .filter(Boolean).join(' ').toLowerCase();
      let score = 0;
      for (const w of words) if (searchable.includes(w)) score++;
      return { memory, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 12).map(i => i.memory);
  } catch (e) {
    console.error('Memory error:', e?.message || e);
    return [];
  }
}

function buildMemoryContext(memories) {
  if (!memories.length) return '';
  const lines = memories.map(m => {
    const cat = m.category || m.type || 'memory';
    const key = m.key || m.name || '';
    const val = m.value ?? m.content ?? '';
    return `- [${cat}] ${key}: ${val}`;
  });
  return `\n\nRELEVANT USER MEMORY:\n${lines.join('\n')}\n\nUse these memories naturally when relevant. Do not mention the memory system. Do not invent memories.`;
}

/* =========================================================
   SEARCH DETECTION
   ========================================================= */

function looksLikeFreshInfoQuestion(text) {
  const t = String(text || '').toLowerCase();
  const patterns = [
    'latest','today',"today's",'right now','currently','current','this week','this month',
    'recent','recently','newest','news','update','updates','2026','2025','price today',
    'weather','score','scores','result','results','release date','released','available now',
    'who won','current president','current prime minister','aaj','abhi','kab','kab release','kya hua'
  ];
  return patterns.some(p => t.includes(p));
}

function definitelyDoesNotNeedSearch(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return true;
  const patterns = ['solve','calculate','simplify','factorize','factorise','equation','homework',
    'physics numerical','chemistry equation','translate','rewrite','rephrase','proofread',
    'debug this code','explain this code'];
  return patterns.some(p => t.startsWith(p) || t.includes(p));
}

/* =========================================================
   GEMINI TEXT EXTRACTION
   ========================================================= */

function extractModelText(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return data.map(extractModelText).filter(Boolean).join('');
  if (data.text) return data.text;
  if (Array.isArray(data.candidates)) {
    return data.candidates.map(c => {
      const parts = c?.content?.parts || [];
      return parts.map(p => p?.text || '').join('');
    }).join('');
  }
  return '';
}

/* =========================================================
   SEARCH DECISION (via Radox fast model)
   ========================================================= */

async function askSearchDecision(userText) {
  if (!userText) return false;
  if (looksLikeFreshInfoQuestion(userText)) return true;
  if (definitelyDoesNotNeedSearch(userText)) return false;

  const key = process.env.RADOX_API_KEY;
  if (!key) return false;

  try {
    const res = await fetchWithTimeout(RADOX_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: RADOX_DECISION_MODEL,
        messages: [
          { role: 'system', content: 'You decide if a user question needs a live web search. Reply ONLY "YES" or "NO".' },
          { role: 'user', content: `Question: ${userText}\n\nDoes this need current/live web information? Reply YES or NO only.` }
        ],
        temperature: 0,
        max_tokens: 5,
        stream: false
      })
    }, 6000);

    if (!res.ok) return false;
    const data = await res.json();
    const answer = (data?.choices?.[0]?.message?.content || '').trim().toUpperCase();
    return answer.startsWith('YES');
  } catch (e) {
    console.error('Search decision error:', e?.message || e);
    return false;
  }
}

/* =========================================================
   QUANTUM SEARCH — Multi-Source Aggregator
   ========================================================= */

async function quantumSearch(query) {
  if (!query) return [];
  const settled = await Promise.allSettled([
    duckDuckGoSearch(query),
    wikipediaSearch(query),
    wikidataSearch(query),
    googleNewsSearch(query)
  ]);
  const names = ['DuckDuckGo', 'Wikipedia', 'Wikidata', 'News'];
  const allResults = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value && Array.isArray(r.value.results) && r.value.results.length) {
      allResults.push(...r.value.results.map(x => ({ ...x, source: names[i] })));
    }
  });
  const seen = new Set();
  const merged = [];
  for (const r of allResults) {
    const key = (r.url || r.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
    if (key && !seen.has(key)) { seen.add(key); merged.push(r); }
  }
  return merged.slice(0, 12);
}

async function duckDuckGoSearch(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'QuantumCore/1.0' } }, 8000);
    if (!res.ok) return { results: [], error: 'HTTP ' + res.status };
    const data = await res.json();
    const results = [];
    if (data.AbstractText && data.AbstractURL) {
      results.push({ title: data.Heading || query, url: data.AbstractURL, content: data.AbstractText });
    }
    if (data.Answer && data.AbstractURL) {
      results.push({ title: 'Answer', url: data.AbstractURL, content: String(data.Answer) });
    }
    (data.RelatedTopics || []).slice(0, 5).forEach(t => {
      if (t.Text && t.FirstURL) results.push({ title: t.Text.slice(0, 90), url: t.FirstURL, content: t.Text });
      else if (t.Topics && Array.isArray(t.Topics)) {
        t.Topics.slice(0, 2).forEach(st => {
          if (st.Text && st.FirstURL) results.push({ title: st.Text.slice(0, 90), url: st.FirstURL, content: st.Text });
        });
      }
    });
    return { results, error: null };
  } catch (err) { return { results: [], error: err.message }; }
}

async function wikipediaSearch(query) {
  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3&origin=*`;
    const res = await fetchWithTimeout(searchUrl, { headers: { 'User-Agent': 'QuantumCore/1.0' } }, 8000);
    if (!res.ok) return { results: [], error: 'HTTP ' + res.status };
    const data = await res.json();
    const searchResults = (data.query && data.query.search) || [];
    const results = searchResults.map(r => ({
      title: r.title || '',
      url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(r.title),
      content: (r.snippet || '').replace(/<[^>]+>/g, '')
    }));
    if (searchResults.length > 0) {
      const topTitle = searchResults[0].title;
      try {
        const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topTitle)}`;
        const sumRes = await fetchWithTimeout(summaryUrl, { headers: { 'User-Agent': 'QuantumCore/1.0' } }, 6000);
        if (sumRes.ok) {
          const sumData = await sumRes.json();
          if (sumData.extract) {
            results[0].content = sumData.extract;
            if (sumData.content_urls && sumData.content_urls.desktop) results[0].url = sumData.content_urls.desktop.page;
          }
        }
      } catch (e) {}
    }
    return { results, error: null };
  } catch (err) { return { results: [], error: err.message }; }
}

async function wikidataSearch(query) {
  try {
    const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&format=json&limit=3&origin=*`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'QuantumCore/1.0' } }, 8000);
    if (!res.ok) return { results: [], error: 'HTTP ' + res.status };
    const data = await res.json();
    const results = (data.search || []).slice(0, 3).map(r => ({
      title: r.label || r.id || '',
      url: r.concepturi || `https://www.wikidata.org/wiki/${r.id}`,
      content: (r.description || '') + (r.aliases && r.aliases.length ? ' (aliases: ' + r.aliases.slice(0, 3).join(', ') + ')' : '')
    })).filter(r => r.content);
    return { results, error: null };
  } catch (err) { return { results: [], error: err.message }; }
}

async function googleNewsSearch(query) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuantumCore/1.0)' } }, 8000);
    if (!res.ok) return { results: [], error: 'HTTP ' + res.status };
    const xml = await res.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 6) {
      const itemXml = match[1];
      const title = (itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
      const link = (itemXml.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      const pubDate = (itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      const description = (itemXml.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) || [])[1] || '';
      if (title) {
        items.push({
          title: title.replace(/<[^>]+>/g, '').trim(),
          url: link.trim(),
          content: (pubDate ? '[' + pubDate + '] ' : '') + description.replace(/<[^>]+>/g, '').slice(0, 300)
        });
      }
    }
    return { results: items, error: null };
  } catch (err) { return { results: [], error: err.message }; }
}

function buildSearchContext(results) {
  if (!results || !results.length) return '';
  return `\n\nWEB SEARCH RESULTS:\n${results.map((r, i) =>
    `\n[${i + 1}] [${r.source || 'Web'}]\nTitle: ${r.title || ''}\nURL: ${r.url || ''}\nContent: ${r.content || ''}\n`
  ).join('\n')}\n\nUse the web results when relevant. Cite sources as [1], [2], etc. Do not invent facts contradicted by search results.`;
}

/* =========================================================
   MERMAID SAFETY INSTRUCTION
   ========================================================= */

const diagramInstruction = `

DIAGRAM SAFETY:
When creating Mermaid diagrams:
- Use valid Mermaid syntax.
- Keep node IDs simple.
- Never use raw coordinate pairs as node IDs.
- Close every Mermaid code fence.

For mathematical diagrams, prefer:
flowchart LR
    A["Point A"]
    B["Point B"]
    A --> B
`;

/* =========================================================
   SOURCES EVENT HELPER
   ========================================================= */

function sourcesEventForClient(searchResults) {
  if (!searchResults || !searchResults.length) return null;
  return searchResults.slice(0, 10).map(r => ({
    title: r.title || '',
    url: r.url || '',
    source: r.source || 'Web'
  }));
}

/* =========================================================
   RADOX STREAM → CLIENT SSE
   ========================================================= */

async function streamRadoxToClient(radoxResponse, searchResults) {
  if (!radoxResponse.body) throw new Error('Radox returned no stream body');
  const reader = radoxResponse.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const stream = new ReadableStream({
    async start(controller) {
      const send = obj => controller.enqueue(encoder.encode(sseEvent(obj)));
      try {
        send({ type: 'status', status: 'Thinking...' });
        
        // Send sources early so frontend can render them
        const srcEvt = sourcesEventForClient(searchResults);
        if (srcEvt) send({ type: 'sources', sources: srcEvt });

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const raw = trimmed.substring(5).trim();
            if (!raw || raw === '[DONE]') continue;
            try {
              const parsed = JSON.parse(raw);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) send({ type: 'chunk', text: delta });
            } catch {}
          }
        }
        send({ type: 'done' });
        controller.close();
      } catch (error) {
        console.error('Radox stream error:', error?.message || error);
        send({ type: 'error', error: error?.message || 'Streaming error' });
        controller.close();
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    }
  });
  return stream;
}

/* =========================================================
   GEMINI STREAM → CLIENT SSE (Fallback)
   ========================================================= */

async function streamGeminiToClient(geminiResponse, searchResults) {
  const reader = geminiResponse.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const stream = new ReadableStream({
    async start(controller) {
      const send = obj => controller.enqueue(encoder.encode(sseEvent(obj)));
      try {
        send({ type: 'status', status: 'Thinking...' });

        const srcEvt = sourcesEventForClient(searchResults);
        if (srcEvt) send({ type: 'sources', sources: srcEvt });

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const raw = trimmed.substring(5).trim();
            if (!raw || raw === '[DONE]') continue;
            try {
              const parsed = JSON.parse(raw);
              const text = extractModelText(parsed);
              if (text) send({ type: 'chunk', text });
            } catch {}
          }
        }
        send({ type: 'done' });
        controller.close();
      } catch (error) {
        send({ type: 'error', error: error?.message || 'Streaming error' });
        controller.close();
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    }
  });
  return stream;
}

/* =========================================================
   CALL RADOX AI
   ========================================================= */

async function callRadoxAI(model, messages, systemPrompt, temperature) {
  const key = process.env.RADOX_API_KEY;
  if (!key) throw new Error('RADOX_API_KEY not configured');

  const res = await fetchWithTimeout(RADOX_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ],
      temperature: typeof temperature === 'number' ? temperature : 0.7,
      max_tokens: 8192,
      stream: true
    })
  }, 60000);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Radox ${model} HTTP ${res.status}: ${err.substring(0, 200)}`);
  }
  return res;
}

/* =========================================================
   CALL GEMINI (fallback)
   ========================================================= */

async function callGemini(model, contents, systemInstruction, generationConfig) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured');

  const url = `${GEMINI_API}${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: systemInstruction }] },
      generationConfig
    })
  }, 60000);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${model} HTTP ${res.status}: ${err.substring(0, 200)}`);
  }
  return res;
}

/* =========================================================
   CONVERT CONTENTS → OPENAI MESSAGES
   ========================================================= */

function contentsToMessages(contents) {
  const messages = [];
  for (const m of contents) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const text = (m.parts || []).map(p => {
      if (typeof p.text === 'string') return p.text;
      if (p.inlineData) return '[image attached]';
      return '';
    }).join('\n').trim();
    if (text) messages.push({ role, content: text });
  }
  return messages;
}

/* =========================================================
   MAIN HANDLER
   ========================================================= */

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid request body' }, 400); }

  const contents = Array.isArray(body?.contents) ? body.contents : [];
  const userId = body?.userId || '';
  const conversationId = body?.conversationId || '';
  const activeMode = body?.mode || 'fast';

  const generationConfig = (body?.generationConfig && typeof body.generationConfig === 'object')
    ? body.generationConfig
    : { temperature: 0.7 };

  if (!contents.length) return json({ error: 'Invalid request: contents missing' }, 400);
  const userText = getLatestUserText(contents);
  if (!userText) return json({ error: 'Invalid request: user message missing' }, 400);

  // Memory + search decision in parallel
  const [memories, shouldSearch] = await Promise.all([
    fetchMemories(userId, userText),
    askSearchDecision(userText)
  ]);

  // Web search
  let searchResults = [];
  if (shouldSearch) {
    searchResults = await quantumSearch(userText);
  }

  // System instruction
  const clientInstruction = body?.systemInstruction?.parts?.[0]?.text || '';
  const memoryContext = buildMemoryContext(memories);
  const searchContext = buildSearchContext(searchResults);

  const finalSystemInstruction = `
${clientInstruction}

CURRENT DATE: October 14, 2026.
${memoryContext}
${searchContext}
${diagramInstruction}

GENERAL RULES:
- Be accurate and helpful.
- Follow the user's requested language.
- Do not invent facts.
- For math and physics, show useful working.
- For coding, provide working code.
- Use web results for current information when provided.
- When citing sources, use [1], [2], [3] format matching the numbered WEB SEARCH RESULTS above.
`;

  // Try Radox models
  const radoxChain = RADOX_MODELS[activeMode] || RADOX_MODELS.fast;
  const openaiMessages = contentsToMessages(contents);
  let lastError = null;

  for (const model of radoxChain) {
    try {
      console.log(`Trying Radox: ${model}`);
      const radoxRes = await callRadoxAI(model, openaiMessages, finalSystemInstruction, generationConfig.temperature);
      const stream = await streamRadoxToClient(radoxRes, searchResults);
      return new Response(stream, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Provider': 'radox',
          'X-Model-Used': model
        }
      });
    } catch (error) {
      lastError = error;
      console.error(`Radox ${model} failed:`, error?.message || error);
    }
  }

  // Gemini fallback
  console.log('All Radox models failed. Trying Gemini fallback...');
  const geminiChain = GEMINI_MODEL_CHAIN[activeMode] || GEMINI_MODEL_CHAIN.fast;

  for (const model of geminiChain) {
    try {
      console.log(`Trying Gemini fallback: ${model}`);
      const geminiRes = await callGemini(model, contents, finalSystemInstruction, generationConfig);
      const stream = await streamGeminiToClient(geminiRes, searchResults);
      return new Response(stream, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Provider': 'gemini-fallback',
          'X-Model-Used': model
        }
      });
    } catch (error) {
      lastError = error;
      console.error(`Gemini ${model} failed:`, error?.message || error);
    }
  }

  return json({
    error: 'All AI models failed',
    details: lastError?.message || 'Unknown server error'
  }, 500);
}