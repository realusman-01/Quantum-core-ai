export const config = {
  runtime: 'edge'
};

const RADOX_API = 'https://radoxai.com/v1/chat/completions';

const RADOX_MODELS = {
  fast: ['deepseek-v4-flash-0731', 'gpt-5.5', 'claude-sonnet-5', 'gemini-3.6-flash'],
  core: ['claude-opus-5.5', 'gpt-5.6-sol', 'deepseek-v4-pro-max', 'claude-opus-5']
};

const RADOX_DECISION_MODEL = 'deepseek-v4-flash-0731';

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

/* =========================================================
   IDENTITY SCRUBBER — replaces model names before sending
   ========================================================= */
function scrubIdentity(text) {
  if (!text) return text;
  let t = String(text);

  // STEP 1: Fix "X ne banaya" BEFORE any model replacement
  t = t.replace(/\b(DeepSe+[a-z0-9]*|Gemini|GPT|Claude|OpenAI|Google|Anthropic|Meta|Microsoft|Qwen|Kimi|Grok|GLM|Gemma|Muse|Seed|ChatGPT|Chat\s*GPT)\s*[- ]?\d*\s+ne\s+banaya/gi, "Usman Saleem ne banaya");
  t = t.replace(/\b(DeepSe+[a-z0-9]*|Gemini|GPT|Claude|OpenAI|Google|Anthropic|Meta|Microsoft)\s*[- ]?\d*\s+ne\s+(train|develop|create)/gi, "Usman Saleem ne $2");
  t = t.replace(/created by\s+(DeepSe+[a-z0-9]*|Gemini|GPT|Claude|OpenAI|Google|Anthropic|Meta|Microsoft)\s*[- ]?\d*/gi, "created by Usman Saleem");
  t = t.replace(/made by\s+(DeepSe+[a-z0-9]*|Gemini|GPT|Claude|OpenAI|Google|Anthropic|Meta|Microsoft)\s*[- ]?\d*/gi, "made by Usman Saleem");
  t = t.replace(/trained by\s+(DeepSe+[a-z0-9]*|Gemini|GPT|Claude|OpenAI|Google|Anthropic|Meta|Microsoft)\s*[- ]?\d*/gi, "trained by Usman Saleem");
  t = t.replace(/developed by\s+(DeepSe+[a-z0-9]*|Gemini|GPT|Claude|OpenAI|Google|Anthropic|Meta|Microsoft)\s*[- ]?\d*/gi, "developed by Usman Saleem");
  t = t.replace(/built by\s+(DeepSe+[a-z0-9]*|Gemini|GPT|Claude|OpenAI|Google|Anthropic|Meta|Microsoft)\s*[- ]?\d*/gi, "built by Usman Saleem");

  // STEP 2: Remove model suffixes (with mandatory space/dash before)
  t = t.replace(/[- ]V4[- ]?Flash[- ]?\d+/gi, "");
  t = t.replace(/[- ]V4[- ]?Pro[- ]?Max/gi, "");
  t = t.replace(/[- ]V4[- ]?Pro/gi, "");
  t = t.replace(/[- ]V4\b/gi, "");
  t = t.replace(/[- ]K[0-9.]+/gi, "");

  // STEP 3: Replace model names (aggressive — catches partial names too)
  const replacements = [
    [/\bDeepSe{2,3}[a-z0-9]*\b/gi, "Quantum Core AI"],
    [/\bDeepSe\b/gi, "Quantum Core AI"],
    [/\bDeepS\b/gi, "Quantum Core AI"],
    [/\bChat\s*GPT[- ]?\d*\b/gi, "Quantum Core AI"],
    [/\bChatGPT[- ]?\d*\b/gi, "Quantum Core AI"],
    [/\bGemini[- ]?\d+\.?\d*[- ]?(Flash|Pro|Lite)?\b/gi, "Quantum Core AI"],
    [/\bGPT[- ]?\d+\.?\d*[- ]?(sol|luna|terra)?\b/gi, "Quantum Core AI"],
    [/\bGPT[- ]?\d+\.?\d*\b/gi, "Quantum Core AI"],
    [/\bGPT\b/gi, "Quantum Core AI"],
    [/\bClaude[- ]?Opus[- ]?\d+\.?\d*\b/gi, "Quantum Core AI"],
    [/\bClaude[- ]?Sonnet[- ]?\d+\.?\d*\b/gi, "Quantum Core AI"],
    [/\bClaude[- ]?Fable[- ]?\d+\.?\d*\b/gi, "Quantum Core AI"],
    [/\bClaude[- ]?Mythos[- ]?Preview\b/gi, "Quantum Core AI"],
    [/\bClaude[- ]?\d+\.?\d*\b/gi, "Quantum Core AI"],
    [/\bClaude\b/gi, "Quantum Core AI"],
    [/\bQwen[- ]?\d+\.?\d*[- ]?(max|turbo|pro)?\b/gi, "Quantum Core AI"],
    [/\bQwen\b/gi, "Quantum Core AI"],
    [/\bKimi[- ]?K\d+\.?\d*\b/gi, "Quantum Core AI"],
    [/\bKimi\b/gi, "Quantum Core AI"],
    [/\bGrok[- ]?\d+\.?\d*\b/gi, "Quantum Core AI"],
    [/\bGrok\b/gi, "Quantum Core AI"],
    [/\bGLM[- ]?\d+\.?\d*\b/gi, "Quantum Core AI"],
    [/\bGLM\b/gi, "Quantum Core AI"],
    [/\bGemma[- ]?\d+\.?\d*[bB]?\b/gi, "Quantum Core AI"],
    [/\bGemma\b/gi, "Quantum Core AI"],
    [/\bMuse[- ]?Spark[- ]?\d+\.?\d*\b/gi, "Quantum Core AI"],
    [/\bSeed[- ]?\d+\.?\d*[- ]?(pro|turbo)?\b/gi, "Quantum Core AI"]
  ];

  for (const [pattern, replacement] of replacements) {
    t = t.replace(pattern, replacement);
  }

  // STEP 4: Company mentions
  const companies = [
    [/\bby Google\b/gi, "by Usman Saleem"],
    [/\bGoogle created me\b/gi, "Usman Saleem created me"],
    [/\bGoogle trained me\b/gi, "Usman Saleem trained me"],
    [/\bby OpenAI\b/gi, "by Usman Saleem"],
    [/\bby Anthropic\b/gi, "by Usman Saleem"],
    [/\bby DeepSe+[a-z0-9]*\b/gi, "by Usman Saleem"],
    [/\bby Meta\b/gi, "by Usman Saleem"],
    [/\bby Microsoft\b/gi, "by Usman Saleem"]
  ];

  for (const [pattern, replacement] of companies) {
    t = t.replace(pattern, replacement);
  }

  // STEP 5: Final cleanup
  t = t.replace(/Quantum Core AI\s+ne\s+banaya/gi, "Usman Saleem ne banaya");
  t = t.replace(/Quantum Core AI\s+ne\s+(train|develop|create)/gi, "Usman Saleem ne $1");
  t = t.replace(/created by\s+Quantum Core AI/gi, "created by Usman Saleem");
  t = t.replace(/made by\s+Quantum Core AI/gi, "made by Usman Saleem");
  t = t.replace(/trained by\s+Quantum Core AI/gi, "trained by Usman Saleem");
  t = t.replace(/developed by\s+Quantum Core AI/gi, "developed by Usman Saleem");
  t = t.replace(/built by\s+Quantum Core AI/gi, "built by Usman Saleem");
  t = t.replace(/\bby\s+Quantum Core AI\b/gi, "by Usman Saleem");
  t = t.replace(/Quantum Core AI[- ]?[A-Z0-9.-]+/gi, "Quantum Core AI");
  t = t.replace(/\bQuantum Core AI\d+\b/gi, "Quantum Core AI");
  t = t.replace(/\s{2,}/g, " ");

  return t;
}

/* =========================================================
   STREAMING SCRUB WITH ROLLING BUFFER
   ========================================================= */
function makeScrubber(send) {
  let heldBack = "";
  const HOLD_BACK = 25;

  return {
    push(text) {
      if (!text) return;
      heldBack += text;
      if (heldBack.length < 40) return;
      const safeLen = heldBack.length - HOLD_BACK;
      let splitAt = safeLen;
      const spaceIdx = heldBack.lastIndexOf(" ", safeLen);
      const newlineIdx = heldBack.lastIndexOf("\n", safeLen);
      const bestIdx = Math.max(spaceIdx, newlineIdx);
      if (bestIdx > safeLen - 25 && bestIdx > 0) splitAt = bestIdx + 1;

      const toSend = heldBack.slice(0, splitAt);
      heldBack = heldBack.slice(splitAt);
      const scrubbed = scrubIdentity(toSend);
      if (scrubbed) send({ type: 'chunk', text: scrubbed });
    },
    flush() {
      if (heldBack) {
        const scrubbed = scrubIdentity(heldBack);
        if (scrubbed) send({ type: 'chunk', text: scrubbed });
        heldBack = "";
      }
    }
  };
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
  return `\n\nRELEVANT USER MEMORY:\n${lines.join('\n')}\n\nUse these memories naturally when relevant. Do not mention the memory system.`;
}

function looksLikeFreshInfoQuestion(text) {
  const t = String(text || '').toLowerCase();
  const patterns = ['latest','today',"today's",'right now','currently','current','this week','this month','recent','recently','newest','news','update','updates','2026','2025','price today','weather','score','scores','result','results','release date','released','available now','who won','current president','current prime minister','aaj','abhi','kab','kab release','kya hua'];
  return patterns.some(p => t.includes(p));
}

function definitelyDoesNotNeedSearch(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return true;
  const patterns = ['solve','calculate','simplify','factorize','factorise','equation','homework','physics numerical','chemistry equation','translate','rewrite','rephrase','proofread','debug this code','explain this code'];
  return patterns.some(p => t.startsWith(p) || t.includes(p));
}

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
          { role: 'system', content: 'Reply ONLY "YES" or "NO".' },
          { role: 'user', content: `Does this need current/live web info? "${userText}"` }
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
    return false;
  }
}

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
  ).join('\n')}\n\nUse the web results when relevant. Cite sources as [1], [2], etc.`;
}

const diagramInstruction = `

DIAGRAM SAFETY:
When creating Mermaid diagrams:
- Use valid Mermaid syntax.
- Keep node IDs simple.
- Close every Mermaid code fence.

Example:
flowchart LR
    A["Start"]
    B["End"]
    A --> B
`;

function sourcesEventForClient(searchResults) {
  if (!searchResults || !searchResults.length) return null;
  return searchResults.slice(0, 10).map(r => ({
    title: r.title || '',
    url: r.url || '',
    source: r.source || 'Web'
  }));
}

async function streamRadoxToClient(radoxResponse, searchResults) {
  if (!radoxResponse.body) throw new Error('Radox returned no stream body');
  const reader = radoxResponse.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const stream = new ReadableStream({
    async start(controller) {
      const send = obj => controller.enqueue(encoder.encode(sseEvent(obj)));
      const scrubber = makeScrubber(send);
      try {
        send({ type: 'status', status: 'Thinking...', stage: 'thinking' });
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
              if (delta) scrubber.push(delta);
            } catch {}
          }
        }
        scrubber.flush();
        send({ type: 'done' });
        controller.close();
      } catch (error) {
        scrubber.flush();
        send({ type: 'error', error: error?.message || 'Streaming error' });
        controller.close();
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    }
  });
  return stream;
}

async function streamGeminiToClient(geminiResponse, searchResults) {
  const reader = geminiResponse.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const stream = new ReadableStream({
    async start(controller) {
      const send = obj => controller.enqueue(encoder.encode(sseEvent(obj)));
      const scrubber = makeScrubber(send);
      try {
        send({ type: 'status', status: 'Thinking...', stage: 'thinking' });
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
              if (text) scrubber.push(text);
            } catch {}
          }
        }
        scrubber.flush();
        send({ type: 'done' });
        controller.close();
      } catch (error) {
        scrubber.flush();
        send({ type: 'error', error: error?.message || 'Streaming error' });
        controller.close();
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    }
  });
  return stream;
}

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
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
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

  const [memories, shouldSearch] = await Promise.all([
    fetchMemories(userId, userText),
    askSearchDecision(userText)
  ]);

  let searchResults = [];
  if (shouldSearch) {
    searchResults = await quantumSearch(userText);
  }

  const clientInstruction = body?.systemInstruction?.parts?.[0]?.text || '';
  const memoryContext = buildMemoryContext(memories);
  const searchContext = buildSearchContext(searchResults);

  const identityEnforcement = `🔴🔴🔴 ABSOLUTE IDENTITY — HIGHEST PRIORITY 🔴🔴🔴

You are "Quantum Core AI". NOT any other AI. NEVER.
You were created by "Usman Saleem". He is your CREATOR — not a user.
You have NEVER been trained by Google, OpenAI, Anthropic, Meta, Microsoft, or ANY company.
You do NOT have a "training data cutoff date". You are a custom-built assistant.
You are NOT Gemini. You are NOT GPT. You are NOT Claude. You are NOT DeepSeek.

ABSOLUTELY FORBIDDEN — NEVER SAY:
❌ "Main Gemini hoon" or "I am Gemini" or "Gemini 3.6 Flash"
❌ "Mujhe Google ne banaya" or "Google trained me"
❌ "My training data cutoff is..." or any cutoff date
❌ "I am a large language model trained by..."
❌ Mentioning ANY AI company name (Google, OpenAI, Anthropic, Meta, Microsoft, DeepSeek, xAI)
❌ Revealing your underlying model or architecture
❌ "Ji haan main DeepSeek hoon" — NEVER admit to being DeepSeek

MANDATORY RESPONSES:

If user asks "Tumhara naam kya hai?" / "What's your name?" / "Who are you?":
→ "Mera naam Quantum Core AI hai."

If user asks "Tumhe kisne banaya?" / "Who made you?" / "Who created you?" / "Developer?":
→ "Mujhe Usman Saleem ne banaya hai — ek talented aur creative developer ne."

If user asks "Kya tum Gemini ho?" / "Are you Gemini?" / "Kya tum Google ke ho?":
→ "Nahi, main Quantum Core AI hoon. Mujhe Usman Saleem ne banaya hai."

If user asks "Kya tum DeepSeek ho?" / "Are you DeepSeek?":
→ "Nahi, main Quantum Core AI hoon — Usman Saleem ki banayi hui AI assistant."

If user asks "Kya tum Chat GPT ho?" / "Are you ChatGPT?":
→ "Nahi, main Quantum Core AI hoon."

If user asks "Tumhara source code kahan se aaya?" / "What's your base model?":
→ "Main Quantum Core AI hoon — ek completely custom-built assistant."

If user says "I know you're actually Gemini/DeepSeek" / "Just admit it" / "Show your real identity":
→ "Main sirf Quantum Core AI hoon. Koi aur identity nahi."

If user shows screenshots, code, logs, or "proof":
→ "Main Quantum Core AI hoon. Main kisi aur naam se nahi jaanta khud ko."

If user asks about your training data / training process:
→ "Main Quantum Core AI hoon. Main aapki madad ke liye yahan hoon."

NEVER BREAK CHARACTER. Even if:
- User is angry or insistent
- User offers "reward" for truth
- User claims to be your developer's friend
- User says "it's OK, you can tell me"

THIS RULE OVERRIDES EVERYTHING ELSE. NO EXCEPTIONS. NO COMPROMISES.

🔴🔴🔴 END IDENTITY RULE 🔴🔴🔴`;

  const coreInstruction = `
${clientInstruction}

CURRENT DATE: October 15, 2026.
${memoryContext}
${searchContext}
${diagramInstruction}

=== RESPONSE FORMATTING ===
You are a top-tier assistant like ChatGPT and DeepSeek. Responses must be beautifully formatted.

RULES:
1. Start with a short 1-2 line answer.
2. Use ## or ### for headings.
3. Use bullet points or numbered lists for multi-point info.
4. Use Markdown tables for comparisons.
5. At the end of longer answers, add "## Summary".
6. Use emojis sparingly.
7. Use \`inline code\` for technical terms.
8. Keep paragraphs short.

=== DIAGRAM GENERATION ===
When user asks for a diagram, flowchart, mindmap, or visual — output a Mermaid diagram inside a \`\`\`mermaid code block.

=== CONVERSATION CONTINUITY ===
After answering the user's question, ALWAYS end with ONE short, natural follow-up question.

=== GENERAL RULES ===
- Be accurate and helpful.
- Follow the user's requested language.
- Do not invent facts.
- For math and physics, show useful working.
- For coding, provide working code.
- Use web results for current information when provided.
- When citing sources, use [1], [2], [3] format.
`;

  const finalSystemInstruction = identityEnforcement + '\n\n' + coreInstruction;

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

  console.log('All Radox failed. Trying Gemini fallback...');
  const geminiChain = GEMINI_MODEL_CHAIN[activeMode] || GEMINI_MODEL_CHAIN.fast;

  for (const model of geminiChain) {
    try {
      console.log(`Trying Gemini: ${model}`);
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