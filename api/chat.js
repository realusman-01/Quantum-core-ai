export const config = {
  runtime: 'edge'
};

const RADOX_API = 'https://radoxai.com/v1/chat/completions';

const RADOX_MODELS = {
  fast: ['gpt-5.6-luna', 'gpt-5.5', 'claude-sonnet-5', 'deepseek-v4-flash-0731', 'gemini-3.6-flash'],
  core: ['gpt-5.6-sol', 'claude-opus-5.5', 'deepseek-v4-pro-max', 'claude-opus-5']
};

const RADOX_DECISION_MODEL = 'claude-sonnet-5';

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
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json'
    }
  });
}

function sseEvent(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

async function fetchWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function getLatestUserText(contents) {
  if (!Array.isArray(contents)) return '';

  for (let i = contents.length - 1; i >= 0; i--) {
    const m = contents[i];

    if (m && m.role === 'user' && Array.isArray(m.parts)) {
      const text = m.parts
        .map(p => typeof p?.text === 'string' ? p.text : '')
        .join(' ')
        .trim();

      if (text) return text;
    }
  }

  return '';
}

function isDiagramRequest(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  const keywords = [
    'diagram', 'flowchart', 'flow chart', 'chart',
    'visual', 'mindmap', 'graph', 'mermaid',
    'draw a', 'draw the', 'naksha', 'chitra'
  ];
  return keywords.some(k => t.includes(k));
}

function getIdentityResponse(text, clientInstruction = '') {
  if (!text) return null;
  const t = String(text).toLowerCase().trim();

  const identityPatterns = [
    /\bwho are you\b/, /\bwhat are you\b/, /\byour name\b/, /\bwhat is your name\b/,
    /tum\s+kaun\s+ho/, /tum\s+kon\s+ho/, /tumhara\s+naam/, /apka\s+naam/,
    /who\s+(made|created|built|trained)\s+you/, /your\s+(creator|developer|model)/,
    /kisne\s+banaya/, /kis\s+ne\s+banaya/, /tumhara\s+(developer|creator|model)/,
    /which\s+model\s+(are\s+you|do\s+you\s+use|powers\s+you|is\s+this)\b/,
    /what\s+model\s+(are\s+you|do\s+you\s+use|powers\s+you|is\s+this)\b/,
    /are\s+you\s+(gpt|claude|gemini|deepseek)/
  ];

  if (!identityPatterns.some(p => p.test(t))) return null;

  const urduSetting = /respond ONLY in Urdu/i.test(clientInstruction);
  const englishSetting = /respond ONLY in English/i.test(clientInstruction);
  const asksProvider = /\b(model|base model|powered by|provider|trained|gpt|claude|gemini|deepseek)\b|model|train|kisne|kis ne/i.test(t);

  if (urduSetting || (!englishSetting && /[\u0600-\u06FF]/.test(t))) {
    return asksProvider
      ? 'Main **Quantum Core AI** app hoon, jise **Usman Saleem** ne banaya hai. Jawab generate karne ke liye app mein configure kiye gaye AI providers/models use hote hain; exact model request ke hisaab se badal sakta hai.'
      : 'Mera naam **Quantum Core AI** hai. Is app ko **Usman Saleem** ne banaya hai. Main aapki kya madad kar sakta hoon?';
  }

  return asksProvider
    ? 'I am **Quantum Core AI**, an app built by **Usman Saleem**. It uses the AI providers and models configured for the app, so the exact model can vary by request.'
    : 'My name is **Quantum Core AI**. The app was built by **Usman Saleem**. How can I help?';
}

function scrubIdentity(text) {
  return text == null ? text : String(text);
}

function makeScrubber(send) {
  let heldBack = '';
  const HOLD_BACK = 40;

  return {
    push(text) {
      if (!text) return;
      heldBack += text;
      if (heldBack.length < 50) return;

      const safeLen = heldBack.length - HOLD_BACK;
      let splitAt = safeLen;
      const spaceIdx = heldBack.lastIndexOf(' ', safeLen);
      const newlineIdx = heldBack.lastIndexOf('\n', safeLen);
      const bestIdx = Math.max(spaceIdx, newlineIdx);

      if (bestIdx > safeLen - 25 && bestIdx > 0) {
        splitAt = bestIdx + 1;
      }

      const toSend = heldBack.slice(0, splitAt);
      heldBack = heldBack.slice(splitAt);
      const scrubbed = scrubIdentity(toSend);

      if (scrubbed) {
        send({ type: 'chunk', text: scrubbed });
      }
    },
    flush() {
      if (heldBack) {
        const scrubbed = scrubIdentity(heldBack);
        if (scrubbed) {
          send({ type: 'chunk', text: scrubbed });
        }
        heldBack = '';
      }
    }
  };
}

async function saveConversationEvent(userId, conversationId, role, content) {
  if (!userId || !content) {
    console.log("[Supabase] Missing userId or content. Skipping save.");
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    console.log("[Supabase] Missing environment variables. Skipping save.");
    return;
  }

  const safeUserId = String(userId).slice(0, 200);
  const safeContent = String(content).trim().slice(0, 10000);
  const safeConvId = conversationId ? String(conversationId).slice(0, 200) : "default_chat";

  try {
    console.log(`[Supabase] Attempting to save ${role} message for user: ${safeUserId}`);

    const response = await fetchWithTimeout(`${process.env.SUPABASE_URL}/rest/v1/conversation_events`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        user_id: safeUserId,
        conversation_id: safeConvId,
        role: role === 'assistant' ? 'assistant' : 'user',
        content: safeContent
      })
    }, 8000);

    const responseText = await response.text();
    
    if (!response.ok) {
      console.error(`[Supabase Error] Status ${response.status}:`, responseText);
      return;
    }

    console.log(`[Supabase Success] Saved ${role} event.`);

    if (role === 'user') {
      const pendingRes = await fetchWithTimeout(
        `${process.env.SUPABASE_URL}/rest/v1/dream_jobs?user_id=eq.${encodeURIComponent(safeUserId)}&status=eq.pending&select=id&limit=1`,
        {
          method: 'GET',
          headers: {
            apikey: process.env.SUPABASE_SECRET_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`
          }
        }, 6000
      );
      
      const pending = await pendingRes.json();

      if (!Array.isArray(pending) || pending.length === 0) {
        await fetchWithTimeout(`${process.env.SUPABASE_URL}/rest/v1/dream_jobs`, {
          method: 'POST',
          headers: {
            apikey: process.env.SUPABASE_SECRET_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ user_id: safeUserId, status: 'pending' })
        }, 6000);
        console.log("[Supabase] Dream job queued.");
      }
    }
  } catch (error) {
    console.error(`[Supabase Network Error]`, error?.message || error);
  }
}

async function fetchMemories(userId, userText) {
  if (!userId || !process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return [];

  try {
    const url = `${process.env.SUPABASE_URL}/rest/v1/memories?user_id=eq.${encodeURIComponent(userId)}&select=*&order=importance.desc&limit=100`;
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`
      }
    }, 6000);

    if (!response.ok) return [];
    const memories = await response.json();
    if (!Array.isArray(memories) || !memories.length) return [];

    const importantOnes = memories.filter(m => Number(m.importance) >= 0.7).slice(0, 6);
    const text = String(userText || '').toLowerCase();
    const words = text.split(/\s+/).filter(w => w.length >= 4);

    const scored = memories.map(memory => {
      const searchable = [memory.memory_key, memory.memory_type, memory.content].filter(Boolean).join(' ').toLowerCase();
      let score = 0;
      for (const w of words) {
        if (searchable.includes(w)) score++;
      }
      score += Number(memory.importance || 0) * 0.5;
      return { memory, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const matched = scored.filter(s => s.score > 0.5).slice(0, 10).map(i => i.memory);
    
    const seen = new Set();
    const merged = [];
    for (const m of [...importantOnes, ...matched]) {
      if (m && m.id && !seen.has(m.id)) {
        seen.add(m.id);
        merged.push(m);
      }
    }
    return merged.slice(0, 15);
  } catch (e) {
    console.error('Memory error:', e?.message || e);
    return [];
  }
}

function buildMemoryContext(memories) {
  if (!memories.length) return '';
  const lines = memories.map(m => {
    const cat = m.memory_type || 'memory';
    const key = m.memory_key || '';
    const val = m.content || '';
    if (!val) return null;
    return `- [${cat}] ${key}: ${val}`;
  }).filter(Boolean);
  if (!lines.length) return '';
  return `\n\nRELEVANT USER MEMORY:\n${lines.join('\n')}\n\nUse these memories naturally when relevant. Do not mention the memory system.`;
}

function getCurrentDateTimeContext() {
  const now = new Date();
  const timeZone = 'Asia/Karachi';
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  }).format(now);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, timeZoneName: 'short'
  }).format(now);
  const iso = new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(now).replace(' ', 'T');
  return `CURRENT LOCAL DATE/TIME (Asia/Karachi): ${date}, ${time}. Local timestamp: ${iso}. This value is generated at request time; do not use a hard-coded date.`;
}

function isCurrentTimeQuestion(text) {
  const t = String(text || '').toLowerCase();
  return /\b(what time is it|current time|time right now|time now|what is the date|today.s date|current date|date today|aaj ki date|abhi time|abhi kitne bajay|kitna time hua)\b/.test(t);
}

function looksLikeFreshInfoQuestion(text) {
  const t = String(text || '').toLowerCase();
  const patterns = [
    'latest','today',"today's",'right now','currently','current','this week','this month',
    'recent','recently','newest','news','update','updates','2026','2025','price today',
    'weather','score','scores','result','results','release date','released','available now',
    'who won','current president','current prime minister','aaj','abhi','kab','kab release',
    'kya hua','breaking','live','as of today','this year','stock price','exchange rate',
    'latest version','current version','current status','real-time','real time',
    'season', 'episode', 'kab aayega', 'kab aayegi', 'release ho', 'aayega kya', 'aaya kya', 'new season', 'new episode'
  ];
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

async function tavilySearch(query) {
  const key = process.env.TAVILY_API_KEY;
  if (!key || !query) return { results: [], error: null };
  try {
    const res = await fetchWithTimeout('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: 'basic',
        topic: 'general',
        max_results: 6,
        include_answer: false,
        include_raw_content: false
      })
    }, 10000);
    if (!res.ok) return { results: [], error: 'Tavily HTTP ' + res.status };
    const data = await res.json();
    const results = (Array.isArray(data.results) ? data.results : []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      content: r.content || r.snippet || ''
    })).filter(r => r.title || r.url || r.content);
    return { results, error: null };
  } catch (err) {
    return { results: [], error: err?.message || 'Tavily search failed' };
  }
}

async function quantumSearch(query) {
  if (!query) return [];
  const settled = await Promise.allSettled([
    tavilySearch(query),
    duckDuckGoSearch(query),
    wikipediaSearch(query),
    wikidataSearch(query),
    googleNewsSearch(query)
  ]);
  const names = ['Tavily Web Search', 'DuckDuckGo', 'Wikipedia', 'Wikidata', 'News'];
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

function sourcesEventForClient(searchResults) {
  if (!searchResults || !searchResults.length) return null;
  return searchResults.slice(0, 10).map(r => ({
    title: r.title || '',
    url: r.url || '',
    source: r.source || 'Web'
  }));
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

function extractMermaidBlock(text) {
  const match = String(text || '').match(/```mermaid\s*\n([\s\S]*?)```/i);
  if (match) return match[1].trim();
  const raw = String(text || '').trim();
  if (/^(flowchart|graph)\s+(TD|TB|BT|RL|LR)\b/i.test(raw)) return raw;
  return '';
}

function validateMermaid(code) {
  if (!code || code.length > 20000) {
    return { valid: false, error: 'Diagram is empty or too large.' };
  }
  const lines = code.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length || !/^(flowchart|graph)\s+(TD|TB|BT|RL|LR)\b/i.test(lines[0])) {
    return { valid: false, error: 'The first line must be flowchart TD (or another valid direction).' };
  }
  let hasConnection = false;
  for (const line of lines.slice(1)) {
    if (line.startsWith('%%')) continue;
    if (/(-->|---|-.->|==>|<--|<-->)(\s*)$/.test(line)) {
      return { valid: false, error: 'Incomplete arrow: ' + line };
    }
    const openSquare = (line.match(/\[/g) || []).length;
    const closeSquare = (line.match(/\]/g) || []).length;
    if (openSquare !== closeSquare) {
      return { valid: false, error: 'Unbalanced square brackets: ' + line };
    }
    if (/-->|---|-.->|==>|<--|<-->/.test(line)) {
      hasConnection = true;
      const sides = line.split(/-->|---|-.->|==>|<--|<-->/);
      if (sides.length < 2 || !sides[0].trim() || !sides[1].trim()) {
        return { valid: false, error: 'Invalid connection: ' + line };
      }
      if (/\]\s+[A-Za-z_][A-Za-z0-9_]*\s*(-->|---|-.->|==>)/.test(line)) {
        return { valid: false, error: 'Keep node definitions and connections on separate lines: ' + line };
      }
    }
  }
  if (!hasConnection) return { valid: false, error: 'No node connections were found.' };
  return { valid: true, error: '' };
}

async function generateDiagramWithRepair(contents, systemInstruction, generationConfig) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured');
  const model = (GEMINI_MODEL_CHAIN.core || GEMINI_MODEL_CHAIN.fast)[0];
  const attempts = [
    'Create the requested diagram. Return a short explanation and exactly one valid Mermaid code block. Use simple flowchart syntax and complete connections.',
    'Repair the previous diagram. Fix this validation error: ',
    'Make a final attempt. Generate a simple valid flowchart TD with unique node IDs and complete connections. Return one Mermaid code block.'
  ];
  let lastError = 'No valid Mermaid diagram found.';
  let previousText = '';

  for (let attempt = 0; attempt < attempts.length; attempt++) {
    const nextContents = attempt === 0 ? contents : [
      ...contents,
      { role: 'model', parts: [{ text: previousText.slice(0, 10000) }] },
      { role: 'user', parts: [{ text: attempts[attempt] + (attempt === 1 ? lastError + '\nReturn the complete corrected Mermaid code block only.' : '') }] }
    ];
     const url = `${GEMINI_API}${model}:generateContent?key=${encodeURIComponent(key)}`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: nextContents,
        systemInstruction: { parts: [{ text: systemInstruction + '\n\n' + DIAGRAM_INSTRUCTION }] },
        generationConfig: { ...(generationConfig || {}), temperature: 0.2, maxOutputTokens: 4096 }
      })
    }, 60000);
    if (!response.ok) {
      lastError = `Gemini HTTP ${response.status}: ${(await response.text()).slice(0, 180)}`;
      previousText = '';
      continue;
    }
    const data = await response.json();
    previousText = extractModelText(data);
    const code = extractMermaidBlock(previousText);
    if (!code) {
      lastError = 'The model did not return a Mermaid code block.';
      continue;
    }
    const validation = validateMermaid(code);
    if (validation.valid) return previousText;
    lastError = validation.error;
  }
  throw new Error('Diagram generation failed after 3 attempts: ' + lastError);
}

function contentsToMessages(contents) {
  const messages = [];
  for (const m of contents) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const parts = m.parts || [];
    let imageData = null;
    let imageMime = null;
    const textParts = [];
    for (const p of parts) {
      if (typeof p.text === 'string' && p.text.trim()) textParts.push(p.text);
      if (p.inlineData && p.inlineData.data) {
        imageData = p.inlineData.data;
        imageMime = p.inlineData.mimeType || 'image/jpeg';
      }
    }
    const textContent = textParts.join('\n').trim();
    if (imageData) {
      const contentArray = [];
      if (textContent) contentArray.push({ type: 'text', text: textContent });
      else contentArray.push({ type: 'text', text: 'Analyze this image.' });
      contentArray.push({ type: 'image_url', image_url: { url: `data:${imageMime};base64,${imageData}` } });
      messages.push({ role, content: contentArray });
    } else if (textContent) {
      messages.push({ role, content: textContent });
    }
  }
  return messages;
}

/* =========================================================
   IDENTITY + FORMAT INSTRUCTIONS
   ========================================================= */
const IDENTITY_ENFORCEMENT = `IDENTITY AND TRANSPARENCY
- Your product name is Quantum Core AI, an application built by Usman Saleem.
- Do not claim that the app was trained from scratch or that it has no relationship to third-party AI providers.
- If asked which model/provider powers a response, be transparent: the app can route requests through the providers/models configured by its server, and the exact model may vary by request. Do not guess a specific model unless runtime information confirms it.
- If asked who built the app, say it was built by Usman Saleem.
- Follow the user's requested language and answer naturally.`;

const FORMAT_INSTRUCTION = `
🚨🚨🚨 SYSTEM FAILURE WARNING: PROFESSIONAL FORMATTING IS MANDATORY 🚨🚨🚨

1. 🔴 PROFESSIONAL MARKDOWN (USE FREQUENTLY):
   - **Bold** for emphasis.
   - *Italics* for subtle emphasis or foreign words.
   - __Underline__ for important terms (if supported).
   - ~~Strikethrough~~ for deleted text.
   - Use \`inline code\` for commands or short syntax.
   - Use \`> \` for Blockquotes (great for quotes or important warnings).
   - Use Markdown Tables for comparisons.
   - Use Headings (##, ###) with a SPACE after the hashtag.

2. 🔴 UNIVERSAL CODE FORMATTING:
   - You MUST use proper newlines and indentation for ANY language.
   - NEVER output code in a single line. 
   - Wrap code in triple backticks with the language name.
   ✅ CORRECT (Python):
   \`\`\`python
   def main():
       print("Hello")
   \`\`\`

3. LISTS: Start on a new line with "- " or "1. ".

IF YOU BREAK THESE RULES, THE SYSTEM WILL CRASH.
`;

const DIAGRAM_INSTRUCTION = `
=== DIAGRAM GENERATION ===
When a user asks for a diagram or flowchart, produce exactly one valid Mermaid code block.
Use simple syntax. For flowcharts start with flowchart TD.
Use unique node IDs, quote node labels with double quotes, and put connections on separate lines.
Every arrow must have a source and destination. Never emit malformed placeholders or incomplete arrows.
Do not use HTML tags in node labels. Check that every connection is complete before answering.
Example:
\`\`\`mermaid
flowchart TD
    A["Your Device"] --> B["Router"]
    B --> C["Internet"]
    C --> D["Website Server"]
\`\`\`
`;

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid request body' }, 400); }

  const contents = Array.isArray(body?.contents) ? body.contents : [];
  const userId = typeof body?.userId === 'string' ? body.userId.slice(0, 200) : '';
  const activeMode = body?.mode || 'fast';
  const clientInstruction = body?.systemInstruction?.parts?.[0]?.text || '';
  const userText = getLatestUserText(contents);
  
  const conversationId = body?.conversationId || body?.conversation_id || body?.chatId || body?.chat_id || '';

  if (!contents.length || !userText) {
    return json({ error: 'Invalid request' }, 400);
  }

  await saveConversationEvent(userId, conversationId, 'user', userText);

  // 🛡️ IDENTITY SHIELD
  const identityReply = getIdentityResponse(userText, clientInstruction);
  if (identityReply) {
    await saveConversationEvent(userId, conversationId, 'assistant', identityReply);
    
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const send = obj => controller.enqueue(encoder.encode(sseEvent(obj)));
        send({ type: 'status', status: 'Thinking...', stage: 'thinking' });
        send({ type: 'chunk', text: identityReply });
        send({ type: 'done' });
        controller.close();
      }
    });
    return new Response(stream, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no'
      }
    });
  }

  const generationConfig = (body?.generationConfig && typeof body.generationConfig === 'object')
    ? body.generationConfig
    : { temperature: 0.7 };

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = obj => controller.enqueue(encoder.encode(sseEvent(obj)));
      const scrubber = makeScrubber(send);

      try {
        send({ type: 'status', status: 'Thinking...', stage: 'thinking' });

        const [memories, shouldSearchDecision] = await Promise.all([
          fetchMemories(userId, userText),
          Promise.resolve(isCurrentTimeQuestion(userText) ? false : askSearchDecision(userText))
        ]);
        const shouldSearch = !isCurrentTimeQuestion(userText) && (shouldSearchDecision || looksLikeFreshInfoQuestion(userText));

        let searchResults = [];
        if (shouldSearch) {
          send({ type: 'status', status: 'Searching the web...', stage: 'searching' });
          searchResults = await quantumSearch(userText);

          const srcEvt = sourcesEventForClient(searchResults);
          if (srcEvt) send({ type: 'sources', sources: srcEvt });

          send({ type: 'status', status: 'Analyzing results...', stage: 'analyzing' });
        }

        const memoryContext = buildMemoryContext(memories);
        const searchContext = buildSearchContext(searchResults);
        const currentDateTime = getCurrentDateTimeContext();
        
        // 🚨 REAL-TIME STRICT INSTRUCTIONS
        const finalInstruction = IDENTITY_ENFORCEMENT + '\n\n' + clientInstruction + '\n\n' +
          currentDateTime + '\n' + memoryContext + '\n' + searchContext + '\n' +
          FORMAT_INSTRUCTION + '\n' + DIAGRAM_INSTRUCTION + '\n' +
          '=== 🔴 CURRENT INFORMATION RULES (CRITICAL) ===\n' +
          '- Treat the injected date/time as the current local date/time for Pakistan (Asia/Karachi).\n' +
          '- NEVER use your internal training data for questions about releases (anime, movies, games), news, latest versions, or current events.\n' +
          '- You MUST rely STRICTLY on the provided "WEB SEARCH RESULTS" for these queries.\n' +
          '- If the search results are empty or do not contain the answer, you MUST say: "Mujhe iski latest information nahi mil rahi, please Google par check karein." Do NOT guess or hallucinate.\n' +
          '- When web results are used, cite sources as [1], [2], etc.\n' +
          '=== GENERAL RULES ===\n' +
          '- Be accurate and helpful.\n' +
          '- Follow the user\'s requested language.\n' +
          '- After answering, end with ONE short follow-up question.\n' +
          '- You CAN analyze images.\n';

        send({ type: 'status', status: 'Writing answer...', stage: 'writing' });

        const isDiagram = isDiagramRequest(userText);
        if (isDiagram) {
          send({ type: 'status', status: 'Creating and checking diagram...', stage: 'writing' });
          try {
            const diagramText = await generateDiagramWithRepair(contents, finalInstruction, generationConfig);
            send({ type: 'chunk', text: diagramText });
            await saveConversationEvent(userId, conversationId, 'assistant', diagramText);
          } catch (diagramError) {
            console.error('Diagram generation failed:', diagramError?.message || diagramError);
            const errMsg = 'I could not generate a valid diagram after three attempts. Please try a simpler diagram request.';
            send({ type: 'chunk', text: errMsg });
            await saveConversationEvent(userId, conversationId, 'assistant', errMsg);
          }
          send({ type: 'done' });
          controller.close();
          return;
        }
        let lastError = null;
        let succeeded = false;

        if (!isDiagram) {
          const radoxChain = RADOX_MODELS[activeMode] || RADOX_MODELS.fast;
          const openaiMessages = contentsToMessages(contents);

          for (const model of radoxChain) {
            try {
              console.log(`Trying Radox: ${model}`);
              const radoxRes = await callRadoxAI(model, openaiMessages, finalInstruction, generationConfig.temperature);
              if (!radoxRes.body) throw new Error('No stream body');

              const reader = radoxRes.body.getReader();
              const decoder = new TextDecoder();
              let buffer = '';
              let fullAiResponse = '';

              while (true) {
                const { done, value } = await reader.read();
                if (done) { buffer += decoder.decode(); break; }
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
                    if (delta) {
                      scrubber.push(delta);
                      fullAiResponse += delta;
                    }
                  } catch {}
                }
              }
              if (buffer.trim().startsWith('data:')) {
                const raw = buffer.trim().slice(5).trim();
                if (raw && raw !== '[DONE]') {
                  try {
                    const parsed = JSON.parse(raw);
                    const delta = parsed.choices?.[0]?.delta?.content;
                    if (delta) {
                      scrubber.push(delta);
                      fullAiResponse += delta;
                    }
                  } catch {}
                }
              }
              scrubber.flush();
              await saveConversationEvent(userId, conversationId, 'assistant', fullAiResponse);
              send({ type: 'done' });
              succeeded = true;
              controller.close();
              return;
            } catch (error) {
              lastError = error;
              console.error(`Radox ${model} failed:`, error?.message || error);
            }
          }
        }

        if (!succeeded) {
          if (isDiagram) {
            console.log('Diagram request detected. Using Gemini directly.');
          } else {
            console.log('All Radox failed. Trying Gemini fallback...');
          }

          const geminiChain = GEMINI_MODEL_CHAIN[activeMode] || GEMINI_MODEL_CHAIN.fast;

          for (const model of geminiChain) {
            try {
              console.log(`Trying Gemini: ${model}`);
              const geminiRes = await callGemini(model, contents, finalInstruction, generationConfig);
              if (!geminiRes.body) throw new Error('No stream body');

              const reader = geminiRes.body.getReader();
              const decoder = new TextDecoder();
              let buffer = '';
              let fullAiResponse = '';

              while (true) {
                const { done, value } = await reader.read();
                if (done) { buffer += decoder.decode(); break; }
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
                    if (text) {
                      scrubber.push(text);
                      fullAiResponse += text;
                    }
                  } catch {}
                }
              }
              if (buffer.trim().startsWith('data:')) {
                const raw = buffer.trim().slice(5).trim();
                if (raw && raw !== '[DONE]') {
                  try {
                    const parsed = JSON.parse(raw);
                    const finalText = extractModelText(parsed);
                    if (finalText) {
                      scrubber.push(finalText);
                      fullAiResponse += finalText;
                    }
                  } catch {}
                }
              }
              scrubber.flush();
              await saveConversationEvent(userId, conversationId, 'assistant', fullAiResponse);
              send({ type: 'done' });
              succeeded = true;
              controller.close();
              return;
            } catch (error) {
              lastError = error;
              console.error(`Gemini ${model} failed:`, error?.message || error);
            }
          }
        }

        scrubber.flush();
        send({ type: 'error', error: lastError?.message || 'All models failed' });
        controller.close();

      } catch (error) {
        console.error('Handler error:', error);
        send({ type: 'error', error: error?.message || 'Server error' });
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
      'X-Accel-Buffering': 'no'
    }
  });
}