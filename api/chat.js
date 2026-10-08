export const config = {
  runtime: 'edge'
};

// ============================================================
// QUANTUM CORE AI - CHAT API
// Optimized + Memory + Web Search + Streaming + Mermaid Safety
// ============================================================

const MODEL_CHAIN = {
  fast: [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite'
  ],
  core: [
    'gemini-3.6-flash',
    'gemini-3.1-flash-lite'
  ]
};

const SEARCH_DECISION_MODEL = 'gemini-3.5-flash-lite';

const GEMINI_API =
  'https://generativelanguage.googleapis.com/v1beta/models/';

const TAVILY_API =
  'https://api.tavily.com/search';

const SUPABASE_TABLE_EVENTS = 'conversation_events';
const SUPABASE_TABLE_JOBS = 'dream_jobs';
const SUPABASE_TABLE_MEMORIES = 'memories';


// ============================================================
// CORS
// ============================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization'
};


// ============================================================
// RESPONSE HELPERS
// ============================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json'
      }
    }
  );
}


// ============================================================
// SUPABASE
// ============================================================

async function supabaseRequest(
  path,
  options = {},
  timeout = 8000
) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeout
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization:
          `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });

    return response;
  } finally {
    clearTimeout(timer);
  }
}


// ============================================================
// DREAMING
// ============================================================

async function queueDreaming(userId, userText) {
  if (!userId || !userText) return;

  try {
    // Save conversation event
    await supabaseRequest(
      SUPABASE_TABLE_EVENTS,
      {
        method: 'POST',
        headers: {
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          user_id: userId,
          role: 'user',
          content: userText
        })
      },
      5000
    );

    // Check whether a pending dream job already exists
    const pendingResponse = await supabaseRequest(
      `${SUPABASE_TABLE_JOBS}?user_id=eq.${encodeURIComponent(userId)}&status=eq.pending&select=id&limit=1`,
      {
        method: 'GET'
      },
      5000
    );

    if (!pendingResponse.ok) return;

    const pendingJobs = await pendingResponse.json();

    if (Array.isArray(pendingJobs) && pendingJobs.length > 0) {
      return;
    }

    // Create a new pending dream job
    await supabaseRequest(
      SUPABASE_TABLE_JOBS,
      {
        method: 'POST',
        headers: {
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          user_id: userId,
          status: 'pending'
        })
      },
      5000
    );

  } catch (error) {
    // Dreaming must NEVER break chat
    console.error(
      'Dreaming queue error:',
      error?.message || error
    );
  }
}


// ============================================================
// MEMORY
// ============================================================

async function fetchMemories(userId, userText) {
  if (!userId) return [];

  try {
    const response = await supabaseRequest(
      `${SUPABASE_TABLE_MEMORIES}?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=50`,
      {
        method: 'GET'
      },
      6000
    );

    if (!response.ok) {
      return [];
    }

    const memories = await response.json();

    if (!Array.isArray(memories)) {
      return [];
    }

    const text = String(userText || '').toLowerCase();

    // Lightweight local relevance scoring
    const scored = memories.map(memory => {
      const searchable = [
        memory.key,
        memory.value,
        memory.category,
        memory.content
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      let score = 0;

      const words = text
        .split(/\s+/)
        .filter(word => word.length >= 4);

      for (const word of words) {
        if (searchable.includes(word)) {
          score++;
        }
      }

      return {
        memory,
        score
      };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored
      .slice(0, 12)
      .map(item => item.memory);

  } catch (error) {
    console.error(
      'Memory fetch error:',
      error?.message || error
    );

    return [];
  }
}


function buildMemoryContext(memories) {
  if (!memories || !memories.length) {
    return '';
  }

  const lines = memories.map(memory => {
    const category =
      memory.category ||
      memory.type ||
      'memory';

    const key =
      memory.key ||
      memory.name ||
      '';

    const value =
      memory.value ??
      memory.content ??
      '';

    return `- [${category}] ${key}: ${value}`;
  });

  return `

RELEVANT USER MEMORY:
${lines.join('\n')}

Use these memories naturally when relevant.
Do not mention the memory system itself.
Do not claim to remember something that is not present here.
`;
}


// ============================================================
// FETCH WITH TIMEOUT
// ============================================================

async function fetchWithTimeout(
  url,
  options = {},
  timeout = 10000
) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeout
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}


// ============================================================
// LATEST USER MESSAGE
// ============================================================

function getLatestUserText(messages) {
  if (!Array.isArray(messages)) return '';

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];

    if (
      message &&
      message.role === 'user'
    ) {
      if (typeof message.content === 'string') {
        return message.content;
      }

      if (Array.isArray(message.content)) {
        return message.content
          .map(part => {
            if (typeof part === 'string') return part;

            return (
              part?.text ||
              part?.content ||
              ''
            );
          })
          .join(' ');
      }
    }
  }

  return '';
}


// ============================================================
// SEARCH DETECTION
// ============================================================

function looksLikeFreshInfoQuestion(text) {
  const t = String(text || '').toLowerCase();

  const patterns = [
    'latest',
    'today',
    'todays',
    'right now',
    'currently',
    'current',
    'this week',
    'this month',
    'recent',
    'recently',
    'newest',
    'news',
    'update',
    'updates',
    '2026',
    'price today',
    'weather',
    'score',
    'result',
    'results',
    'who is the current',
    'who won',
    'release date',
    'released',
    'available now'
  ];

  return patterns.some(
    pattern => t.includes(pattern)
  );
}


function definitelyDoesNotNeedSearch(text) {
  const t = String(text || '').trim().toLowerCase();

  if (!t) return true;

  const patterns = [
    'solve',
    'calculate',
    'simplify',
    'factorize',
    'factorise',
    'equation',
    'homework',
    'physics numerical',
    'chemistry equation',
    'write a paragraph',
    'write an essay',
    'translate',
    'rewrite',
    'rephrase',
    'proofread',
    'explain this code',
    'debug this code',
    'what is',
    'what are',
    'define'
  ];

  return patterns.some(
    pattern => t.startsWith(pattern) || t.includes(pattern)
  );
}


// ============================================================
// GEMINI TEXT EXTRACTION
// ============================================================

function extractModelText(data) {
  if (!data) return '';

  if (typeof data === 'string') {
    return data;
  }

  if (Array.isArray(data)) {
    return data
      .map(extractModelText)
      .filter(Boolean)
      .join('');
  }

  if (data.text) {
    return data.text;
  }

  if (data.candidates) {
    return data.candidates
      .map(candidate => {
        const parts =
          candidate?.content?.parts || [];

        return parts
          .map(part => part?.text || '')
          .join('');
      })
      .join('');
  }

  return '';
}


// ============================================================
// SEARCH DECISION
// ============================================================

async function askSearchDecision(userText) {
  if (!userText) return false;

  // Fresh information should search directly
  if (looksLikeFreshInfoQuestion(userText)) {
    return true;
  }

  // Obvious stable tasks do not need search
  if (definitelyDoesNotNeedSearch(userText)) {
    return false;
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return false;
  }

  try {
    const url =
      `${GEMINI_API}${SEARCH_DECISION_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: `
Decide whether the following user question needs
a live web search.

Return ONLY:
YES
or
NO

Search when the answer may depend on current,
recent, changing, real-world or time-sensitive information.

User question:
${userText}
`
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 3
          }
        })
      },
      6000
    );

    if (!response.ok) {
      return false;
    }

    const data = await response.json();

    const answer =
      extractModelText(data)
        .trim()
        .toUpperCase();

    return answer.startsWith('YES');

  } catch (error) {
    console.error(
      'Search decision error:',
      error?.message || error
    );

    return false;
  }
}


// ============================================================
// TAVILY SEARCH
// ============================================================

async function tavilySearch(query) {
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey || !query) {
    return [];
  }

  try {
    const response = await fetchWithTimeout(
      TAVILY_API,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: 'basic',
          max_results: 6,
          include_answer: false,
          include_raw_content: false
        })
      },
      10000
    );

    if (!response.ok) {
      console.error(
        'Tavily HTTP error:',
        response.status
      );

      return [];
    }

    const data = await response.json();

    return Array.isArray(data?.results)
      ? data.results
      : [];

  } catch (error) {
    console.error(
      'Tavily error:',
      error?.message || error
    );

    return [];
  }
}


// ============================================================
// SEARCH CONTEXT
// ============================================================

function buildSearchContext(results) {
  if (!results || !results.length) {
    return '';
  }

  return `

WEB SEARCH RESULTS:
${results
  .map((result, index) => `
[${index + 1}]
Title: ${result?.title || ''}
URL: ${result?.url || ''}
Content:
${result?.content || ''}
`)
  .join('\n')}

Use these results when answering current-information questions.
Do not invent information that is not supported by the results.
`;
}


// ============================================================
// IMPORTANT FIX
// ============================================================

function appendSourcesToInstruction(
  instruction,
  searchContext
) {
  return `${instruction || ''}${searchContext || ''}`;
}


// ============================================================
// MERMAID SAFETY
// ============================================================

const diagramInstruction = `

DIAGRAM / MERMAID SAFETY:

When generating Mermaid diagrams:

1. Use valid Mermaid syntax only.
2. Never put raw coordinate pairs such as:
   P1(-1, -1)
   inside Mermaid node definitions.
3. If coordinates are needed, describe them as normal text.
4. Never put stray characters after Mermaid nodes.
5. Keep node IDs simple:
   A, B, C, P1, P2, etc.
6. Use safe syntax such as:

flowchart LR
    A["Point A"]
    B["Point B"]
    A --> B

7. For mathematical diagrams, prefer simple
   flowcharts unless another Mermaid diagram type
   is clearly required.
8. Do not mix normal prose into Mermaid code fences.
9. Always close Mermaid code fences properly.

If a diagram is unnecessary, answer normally without Mermaid.
`;


// ============================================================
// GEMINI STREAM
// ============================================================

async function createGeminiStream({
  model,
  messages,
  systemInstruction,
  temperature = 0.7
}) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is missing'
    );
  }

  const url =
    `${GEMINI_API}${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const contents = Array.isArray(messages)
    ? messages.map(message => ({
        role:
          message.role === 'assistant'
            ? 'model'
            : 'user',
        parts: [
          {
            text:
              typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content)
          }
        ]
      }))
    : [];

  const body = {
    systemInstruction: {
      parts: [
        {
          text:
            systemInstruction || ''
        }
      ]
    },

    contents,

    generationConfig: {
      temperature,
      maxOutputTokens: 4096
    }
  };

  // IMPORTANT:
  // Only timeout connection establishment.
  // Do NOT abort the actual streaming response.
  const controller = new AbortController();

  const connectionTimer = setTimeout(
    () => controller.abort(),
    15000
  );

  let response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(connectionTimer);
  }

  if (!response.ok) {
    const errorText =
      await response.text().catch(() => '');

    throw new Error(
      `Gemini ${model} HTTP ${response.status}: ${errorText}`
    );
  }

  if (!response.body) {
    throw new Error(
      'Gemini returned no response body'
    );
  }

  return response;
}


// ============================================================
// MAIN HANDLER
// ============================================================

export default async function handler(req) {

  // ----------------------------------------------------------
  // OPTIONS
  // ----------------------------------------------------------

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }

  // ----------------------------------------------------------
  // METHOD
  // ----------------------------------------------------------

  if (req.method !== 'POST') {
    return json(
      {
        error: 'Method not allowed'
      },
      405
    );
  }

  // ----------------------------------------------------------
  // PARSE BODY
  // ----------------------------------------------------------

  let body;

  try {
    body = await req.json();
  } catch (error) {
    return json(
      {
        error: 'Invalid JSON body'
      },
      400
    );
  }

  const messages =
    Array.isArray(body?.messages)
      ? body.messages
      : [];

  const userId =
    body?.userId ||
    body?.user_id ||
    '';

  const mode =
    body?.mode ||
    'core';

  const originalInstruction =
    body?.systemInstruction ||
    body?.system ||
    `
You are Quantum Core AI.

Be helpful, accurate, natural and concise.
Think through problems carefully before answering.
Use the user's conversation context when available.

For mathematics and physics:
show clear step-by-step working when useful.

For coding:
provide practical, working code and explain important fixes.

Do not fabricate facts.
If live information is required, use the provided web search results.
`;

  // ----------------------------------------------------------
  // USER TEXT
  // ----------------------------------------------------------

  const userText =
    getLatestUserText(messages);

  if (!userText) {
    return json(
      {
        error: 'No user message found'
      },
      400
    );
  }

  // ----------------------------------------------------------
  // START NON-BLOCKING DREAMING
  // ----------------------------------------------------------

  // We intentionally do NOT use context.waitUntil().
  // This keeps the handler compatible and avoids runtime issues.

  if (userId) {
    queueDreaming(
      userId,
      userText
    ).catch(error => {
      console.error(
        'Background dreaming error:',
        error?.message || error
      );
    });
  }

  // ----------------------------------------------------------
  // MEMORY + SEARCH DECISION IN PARALLEL
  // ----------------------------------------------------------

  const memoryPromise =
    fetchMemories(
      userId,
      userText
    );

  const searchDecisionPromise =
    askSearchDecision(
      userText
    );

  let memories = [];
  let shouldSearch = false;

  try {
    [
      memories,
      shouldSearch
    ] = await Promise.all([
      memoryPromise,
      searchDecisionPromise
    ]);
  } catch (error) {
    console.error(
      'Parallel preparation error:',
      error?.message || error
    );
  }

  // ----------------------------------------------------------
  // WEB SEARCH
  // ----------------------------------------------------------

  let searchResults = [];

  if (shouldSearch) {
    searchResults =
      await tavilySearch(
        userText
      );
  }

  // ----------------------------------------------------------
  // CONTEXT
  // ----------------------------------------------------------

  const memoryContext =
    buildMemoryContext(
      memories
    );

  const searchContext =
    buildSearchContext(
      searchResults
    );

  const timeInstruction = `

CURRENT DATE CONTEXT:
The current date is October 8, 2026.
If a question involves relative dates,
interpret them using this date unless
the conversation provides a different context.
`;

  const finalSystemInstruction =
    appendSourcesToInstruction(
      originalInstruction,
      memoryContext +
      timeInstruction +
      diagramInstruction +
      searchContext
    );

  // ----------------------------------------------------------
  // MODEL CHAIN
  // ----------------------------------------------------------

  const chain =
    mode === 'fast'
      ? MODEL_CHAIN.fast
      : MODEL_CHAIN.core;

  let lastError = null;

  // ----------------------------------------------------------
  // STREAMING RESPONSE
  // ----------------------------------------------------------

  for (const model of chain) {

    try {

      const response =
        await createGeminiStream({
          model,
          messages,
          systemInstruction:
            finalSystemInstruction,
          temperature:
            mode === 'fast'
              ? 0.5
              : 0.7
        });

      return new Response(
        response.body,
        {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            'Content-Type':
              'text/event-stream; charset=utf-8',
            'Cache-Control':
              'no-cache, no-transform'
          }
        }
      );

    } catch (error) {

      lastError = error;

      console.error(
        `Gemini model ${model} failed:`,
        error?.message || error
      );

      // Try next fallback model
    }
  }

  // ----------------------------------------------------------
  // ALL MODELS FAILED
  // ----------------------------------------------------------

  return json(
    {
      error:
        'All Gemini models failed',
      details:
        lastError?.message ||
        'Unknown Gemini error'
    },
    500
  );
}