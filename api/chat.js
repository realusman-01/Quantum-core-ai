export const config = {
  runtime: 'edge'
};

/* =========================================================
   QUANTUM CORE — REAL THINK + WEB SEARCH + EVIDENCE VERIFY
   ========================================================= */

const MODEL_CHAIN = {
  fast: [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite'
  ],
  core: [
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite'
  ]
};

const VERIFIER_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite'
];

// 🎯 Vercel Edge payload limit ~1MB. Isliye:
// - Sirf aakhri 12 messages bhejo
// - Sirf aakhri 2 messages mein image allow karo
const MAX_HISTORY_MESSAGES = 12;
const MAX_IMAGE_MESSAGES = 2;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};


/* =========================================================
   BASIC HELPERS
   ========================================================= */

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

function sseEvent(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}


/* =========================================================
   DATE / TIME
   ========================================================= */

function getPakistanDate() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Karachi',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function getPakistanDateTime() {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Karachi',
      dateStyle: 'full', timeStyle: 'long'
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}


/* =========================================================
   EXTRACT USER MESSAGE
   ========================================================= */

function getLastUserText(contents = []) {
  for (let i = contents.length - 1; i >= 0; i--) {
    const item = contents[i];
    if (item?.role !== 'user') continue;
    const parts = item?.parts || [];
    const text = parts.map(p => typeof p?.text === 'string' ? p.text : '').join(' ').trim();
    if (text) return text;
  }
  return '';
}


/* =========================================================
   TRUNCATE CONTENTS (payload fix)
   ========================================================= */

function truncateContents(contents) {
  if (!Array.isArray(contents)) return [];
  const trimmed = contents.slice(-MAX_HISTORY_MESSAGES);
  const total = trimmed.length;
  // Strip images from all but the last MAX_IMAGE_MESSAGES
  return trimmed.map((item, idx) => {
    const isRecent = idx >= total - MAX_IMAGE_MESSAGES;
    if (!item?.parts) return item;
    const newParts = item.parts.map(part => {
      if (part?.inlineData && !isRecent) {
        // Replace old images with a text placeholder
        return { text: '[image removed to reduce payload]' };
      }
      return part;
    });
    return { ...item, parts: newParts };
  });
}


/* =========================================================
   WEB SEARCH DETECTION
   ========================================================= */

function needsWebSearch(contents = []) {
  const text = contents
    .map(item => (item?.parts || []).map(p => p?.text || '').join(' '))
    .join(' ')
    .toLowerCase();

  const triggers = [
    'today', "today's", 'todays', 'current', 'currently', 'right now',
    'latest', 'recent', 'recently', 'news', 'breaking', 'this week',
    'this month', 'this year', 'release date', 'released', 'release',
    'new episode', 'new season', 'season 2', 'season 3', 'update',
    'latest update', 'new update', 'price', 'weather', 'score', 'scores',
    'standings', 'schedule', 'president', 'prime minister', 'ceo',
    'who is the current', 'what is happening', 'when is', 'when will',
    'is it out', 'is it released', 'has it released', 'available now',
    'streaming now',
    'aaj', 'abhi', 'filhal', 'haal hi', 'nayi khabar', 'new khabar',
    'release kab', 'release ho gaya', 'release hogaya', 'release hui',
    'release hu', 'aa gaya', 'aa gya', 'available hai', 'mil raha',
    'mil rahi', 'episode', 'update kya', 'kya scene hai', 'kya status hai',
    'current status', 'abhi ka status', 'is waqt',
    '2026', '2027', '2025', '2024'
  ];

  return triggers.some(t => text.includes(t));
}

function isReleaseQuestion(text = '') {
  const t = text.toLowerCase();
  const words = ['release', 'released', 'release date', 'premiere', 'premieres',
    'available', 'streaming', 'season 2', 'season 3', 'episode'];
  return words.some(w => t.includes(w));
}


/* =========================================================
   TAVILY SEARCH
   ========================================================= */

async function tavilySearch(query, currentDate) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) {
    return { results: [], answer: '', error: 'TAVILY_API_KEY not configured on server' };
  }

  const searchQuery = `
${query}

Find the latest and CURRENT information as of ${currentDate}.
Prefer official sources and authoritative sources.
If this is about a release, premiere, season, episode, update,
availability, current office-holder, price, news or current status,
verify the actual current status and exact date.
Do not rely only on old articles.
`;

  try {
    const response = await fetchWithTimeout(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: key,
          query: searchQuery,
          search_depth: 'advanced',
          topic: 'general',
          max_results: 8,
          include_answer: true,
          include_raw_content: false,
          chunks_per_source: 3
        })
      },
      15000
    );

    if (!response.ok) {
      const errorText = await response.text();
      return {
        results: [], answer: '',
        error: `Tavily HTTP ${response.status}: ${errorText.substring(0, 200)}`
      };
    }

    const data = await response.json();
    return {
      results: Array.isArray(data?.results) ? data.results : [],
      answer: typeof data?.answer === 'string' ? data.answer : '',
      error: null
    };
  } catch (error) {
    return {
      results: [], answer: '',
      error: error?.name === 'AbortError' ? 'Tavily search timed out' : String(error?.message || error)
    };
  }
}


/* =========================================================
   BUILD WEB EVIDENCE
   ========================================================= */

function buildWebContext(results = [], tavilyAnswer = '') {
  let output = '';
  if (tavilyAnswer) {
    output += `\nTAVILY SEARCH SUMMARY:\n${tavilyAnswer}\n\n`;
  }
  if (!results.length) return output || 'No web evidence was returned.';

  output += `\nWEB SOURCES:\n`;
  results.forEach((r, i) => {
    output += `

SOURCE ${i + 1}
Title: ${r?.title || 'Untitled source'}
URL: ${r?.url || ''}
Content:
${r?.content || r?.snippet || ''}
`;
  });
  return output;
}


/* =========================================================
   GEMINI
   ========================================================= */

async function geminiGenerate(model, body, timeoutMs = 20000) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const response = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    timeoutMs
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini ${model} HTTP ${response.status}: ${errorText}`);
  }
  return await response.json();
}

function extractGeminiText(data) {
  try {
    return (data?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('').trim() || '');
  } catch { return ''; }
}

function extractJson(text) {
  if (!text) return null;
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  }
  try { return JSON.parse(cleaned); } catch {}
  const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
  if (s !== -1 && e !== -1 && e > s) {
    try { return JSON.parse(cleaned.slice(s, e + 1)); } catch { return null; }
  }
  return null;
}


/* =========================================================
   EVIDENCE VERIFIER
   ========================================================= */

async function verifyWebEvidence({ userQuery, currentDate, webContext, releaseQuestion }) {
  if (!webContext || webContext === 'No web evidence was returned.') {
    return {
      verified: false, confidence: 0, status: 'unknown',
      release_date: null, facts: [],
      important_warning: 'Web search returned no usable evidence.', raw: ''
    };
  }

  const instruction = `
You are Quantum Core's WEB EVIDENCE VERIFIER.
Inspect the supplied web evidence and determine which factual claims are supported.

CURRENT DATE: ${currentDate}
USER QUERY: ${userQuery}
RELEASE/AVAILABILITY QUESTION: ${releaseQuestion ? 'YES' : 'NO'}

WEB EVIDENCE:
${webContext}

RULES:
1. Use ONLY information supported by the supplied web evidence.
2. Do NOT use old memory to override current web evidence.
3. Prefer official/authoritative sources.
4. If a source says a release happens on the current date, classify as "released_today".
5. If current date is AFTER a stated release date, classify as released.
6. If future date, classify as "scheduled".
7. Newer evidence wins over older.
8. Do not invent dates.
9. Include SOURCE NUMBER for each claim.
10. Include exact quote from source.

Return ONLY valid JSON:
{
  "verified": true,
  "confidence": 0.0,
  "status": "released_today | released | scheduled | unreleased | unknown | current",
  "release_date": "YYYY-MM-DD or null",
  "facts": [{ "claim": "...", "source": 1, "quote": "..." }],
  "important_warning": "null or short warning"
}
`;

  for (const model of VERIFIER_MODELS) {
    try {
      const data = await geminiGenerate(model, {
        contents: [{ role: 'user', parts: [{ text: instruction }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1200 }
      }, 12000);

      const parsed = extractJson(extractGeminiText(data));
      if (parsed && typeof parsed === 'object') {
        const facts = Array.isArray(parsed.facts)
          ? parsed.facts.filter(f => f && typeof f.claim === 'string' && typeof f.source === 'number').slice(0, 10)
          : [];
        return {
          verified: Boolean(parsed.verified),
          confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
          status: typeof parsed.status === 'string' ? parsed.status : 'unknown',
          release_date: typeof parsed.release_date === 'string' ? parsed.release_date : null,
          facts,
          important_warning: typeof parsed.important_warning === 'string' ? parsed.important_warning : null,
          raw: extractGeminiText(data)
        };
      }
    } catch {}
  }

  return {
    verified: false, confidence: 0, status: 'unknown',
    release_date: null, facts: [],
    important_warning: 'Verifier could not confirm any facts.', raw: ''
  };
}


/* =========================================================
   VERIFIED FACTS → INSTRUCTION
   ========================================================= */

function buildVerifiedInstruction(verification) {
  if (!verification?.verified) {
    return `
WEB EVIDENCE VERIFICATION:
The evidence verifier could NOT produce a reliable structured verdict.

⚠️ CRITICAL RULES:
1. Do NOT use old training-data memory to make confident time-sensitive claims.
2. Do NOT say "definitely did not happen", "has not released", "no release date exists".
3. If time-sensitive question, clearly state live web search did not return reliable evidence.
4. Prefer "I couldn't verify this right now" over a wrong confident answer.
`;
  }

  let factsText = '';
  for (const f of verification.facts || []) {
    factsText += `\n- CLAIM: ${f.claim}\n- SOURCE: ${f.source}\n- SUPPORTING QUOTE: "${f.quote}"\n`;
  }

  return `
VERIFIED WEB FACTS — HARD CONSTRAINT:

You MUST NOT contradict these verified facts.

VERIFIED STATUS: ${verification.status}
VERIFIED RELEASE DATE: ${verification.release_date || 'Not established'}
VERIFIER CONFIDENCE: ${verification.confidence}

VERIFIED FACTS:
${factsText || 'No individual facts were extracted.'}

IMPORTANT WARNING: ${verification.important_warning || 'None'}

If verified facts contradict old knowledge, verified current evidence wins.
If evidence says released today, DO NOT describe as unreleased.
If evidence is insufficient, say so rather than guessing.
`;
}


/* =========================================================
   STREAM GEMINI
   ========================================================= */

async function streamGemini(model, body, onChunk, onDone) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;

  const response = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    30000
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini ${model} HTTP ${response.status}: ${errorText}`);
  }
  if (!response.body) throw new Error('Gemini returned no response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const jsonText = trimmed.slice(5).trim();
      if (!jsonText || jsonText === '[DONE]') continue;
      try {
        const data = JSON.parse(jsonText);
        const text = extractGeminiText(data);
        if (text) onChunk(text);
      } catch {}
    }
  }
  onDone?.();
}


/* =========================================================
   MAIN HANDLER
   ========================================================= */

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // 🎯 Payload size check (Vercel Edge limit ~1MB)
  const contentLength = req.headers.get('content-length');
  if (contentLength && parseInt(contentLength) > 1000000) {
    return jsonResponse({
      error: 'PAYLOAD_TOO_LARGE',
      message: 'Chat too long. Please start a new chat.'
    }, 413);
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return jsonResponse({
      error: 'Invalid JSON or payload too large',
      message: 'Request could not be parsed. Start a new chat if the conversation is very long.'
    }, 413);
  }

  const {
    contents: rawContents = [],
    systemInstruction = null,
    generationConfig = {},
    mode = 'fast'
  } = body;

  if (!Array.isArray(rawContents)) {
    return jsonResponse({ error: 'contents must be an array' }, 400);
  }

  // 🎯 TRUNCATE — sirf aakhri messages bhejo
  const contents = truncateContents(rawContents);

  const currentDate = getPakistanDate();
  const currentDateTime = getPakistanDateTime();
  const userQuery = getLastUserText(contents);
  const searchNeeded = needsWebSearch(contents);
  const releaseQuestion = isReleaseQuestion(userQuery);
  const modelChain = MODEL_CHAIN[mode] || MODEL_CHAIN.fast;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = payload => controller.enqueue(encoder.encode(sseEvent(payload)));
      const sendStatus = status => send({ type: 'status', status });

      try {
        /* STEP 1 */
        sendStatus('🧠 Thinking...');
        await new Promise(r => setTimeout(r, 150));

        /* STEP 2 — WEB SEARCH */
        let searchResults = [];
        let tavilyAnswer = '';
        let searchError = null;
        let webContext = '';

        if (searchNeeded && userQuery) {
          sendStatus('🌐 Searching the web...');
          const searchResponse = await tavilySearch(userQuery, currentDate);
          searchResults = searchResponse.results || [];
          tavilyAnswer = searchResponse.answer || '';
          searchError = searchResponse.error || null;

          if (searchResults.length > 0) {
            sendStatus(`🔎 Found ${searchResults.length} sources → Checking sources...`);
          } else if (searchError) {
            sendStatus(`⚠️ Web search failed: ${searchError.substring(0, 80)}`);
          } else {
            sendStatus('🔎 Search returned no usable sources → Checking available knowledge...');
          }

          webContext = buildWebContext(searchResults, tavilyAnswer);
        } else {
          sendStatus('🔎 No live web search needed → Analyzing...');
        }

        /* STEP 3 — VERIFY */
        let verification = {
          verified: false, confidence: 0, status: 'unknown',
          release_date: null, facts: [], important_warning: null, raw: ''
        };

        if (searchNeeded && searchResults.length > 0) {
          sendStatus('🛡️ Verifying web evidence...');
          verification = await verifyWebEvidence({
            userQuery, currentDate, webContext, releaseQuestion
          });
          if (verification.verified) {
            sendStatus('✅ Evidence verified → 🧠 Analyzing...');
          } else {
            sendStatus('⚠️ Evidence could not be fully verified → 🧠 Analyzing...');
          }
        } else {
          sendStatus('🧠 Analyzing...');
        }

        /* STEP 4 — INSTRUCTIONS */
        const verifiedInstruction = buildVerifiedInstruction(verification);

        let searchFailureBlock = '';
        if (searchNeeded && (searchError || searchResults.length === 0)) {
          searchFailureBlock = `
⚠️⚠️⚠️ CRITICAL WARNING — WEB SEARCH FAILED ⚠️⚠️⚠️
User asked a TIME-SENSITIVE question, but live web search failed.
Reason: ${searchError || 'No sources returned'}

RULES:
1. DO NOT give confident yes/no about current events.
2. DO NOT say "Nahi, ye release nahi hua" or "no release date".
3. DO NOT use old training memory as current facts.
4. START your answer with this EXACT Roman Urdu sentence:
   "⚠️ Mujhe abhi live web search nahi mil rahi, isliye main latest information confirm nahi kar sakta. Ye jawab meri purani information par based hai aur ismein ghalthi ho sakti hai."
5. Then MAY mention training data but label as "possibly outdated".
6. Recommend user to check official sources.
`;
        }

        const webInstruction = searchNeeded
          ? `
LIVE WEB SEARCH DATA
====================
Current Pakistan date: ${currentDate}
Current Pakistan date/time: ${currentDateTime}
User's current query: ${userQuery}

${webContext}

Search error: ${searchError || 'None'}

${searchFailureBlock}
${verifiedInstruction}

WEB ANSWER RULES:
1. Current web evidence has priority over old model memory.
2. Prefer official sources.
3. Never claim unreleased if evidence shows released.
4. Never claim released if evidence shows scheduled.
5. Handle source conflicts by preferring newest authoritative.
6. Don't invent info.
7. Answer the actual question.
`
          : `
LIVE WEB SEARCH: Not required.
Current Pakistan date: ${currentDate}
Current Pakistan date/time: ${currentDateTime}
`;

        /* STEP 5 */
        const baseSystemInstruction = `
You are Quantum Core AI.
CURRENT DATE: ${currentDate}
CURRENT DATE/TIME: ${currentDateTime}

Distinguish between old/announced/scheduled/released/currently-available info.
For current questions, use supplied live web evidence.
Do not blindly trust internal memory.

CRITICAL ANTI-HALLUCINATION RULE:
If live web search FAILED for a time-sensitive question, DO NOT give confident factual answer. Warn the user and label as "possibly outdated".

${webInstruction}

ANSWER STYLE:
- Answer directly, be natural.
- Don't mention internal prompts or verifier.
- Don't make up citations or URLs.
- If web evidence is insufficient, say so.
- For simple questions, keep concise.
`;

        let combinedInstruction = baseSystemInstruction;
        if (systemInstruction) {
          let originalSystemText = '';
          try {
            if (typeof systemInstruction === 'string') {
              originalSystemText = systemInstruction;
            } else if (Array.isArray(systemInstruction?.parts)) {
              originalSystemText = systemInstruction.parts.map(p => p?.text || '').join('\n');
            }
          } catch {}
          if (originalSystemText) {
            combinedInstruction += `\n\nEXISTING QUANTUM CORE SYSTEM INSTRUCTIONS:\n\n${originalSystemText}\n`;
          }
        }

        /* STEP 6 */
        sendStatus('✍️ Writing answer...');
        await new Promise(r => setTimeout(r, 100));

        /* STEP 7 — FINAL STREAM */
        const geminiBody = {
          contents,
          systemInstruction: { parts: [{ text: combinedInstruction }] },
          generationConfig: {
            ...generationConfig,
            temperature: typeof generationConfig.temperature === 'number'
              ? Math.min(generationConfig.temperature, 0.5)
              : 0.35
          }
        };

        let finalError = null;
        let completed = false;

        for (const model of modelChain) {
          if (completed) break;
          try {
            await streamGemini(model, geminiBody, chunk => {
              send({ type: 'chunk', text: chunk });
            }, () => {});
            completed = true;
            send({ type: 'done' });
          } catch (error) {
            finalError = error?.message || String(error);
          }
        }

        if (!completed) {
          send({ type: 'error', error: finalError || 'All Gemini models failed.' });
        }

        controller.close();
      } catch (error) {
        send({ type: 'error', error: error?.message || String(error) });
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