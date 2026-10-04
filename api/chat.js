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
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

/* =========================================================
   GET ALL TEXT FROM CONVERSATION
========================================================= */

function getConversationText(contents) {
  return (contents || [])
    .map(m =>
      (m.parts || [])
        .map(p => p.text || '')
        .join(' ')
    )
    .join('\n')
    .trim();
}

/* =========================================================
   LAST USER MESSAGE
========================================================= */

function getLastUserText(contents) {
  for (let i = (contents || []).length - 1; i >= 0; i--) {
    if (contents[i]?.role === 'user') {
      return (contents[i].parts || [])
        .map(p => p.text || '')
        .join(' ')
        .trim();
    }
  }

  return '';
}

/* =========================================================
   SMART WEB SEARCH DETECTION
========================================================= */

function needsWebSearch(contents) {
  const text = getConversationText(contents).toLowerCase();

  if (!text) return false;

  /*
   * Current / time-sensitive information
   */
  const currentTriggers = [
    'today',
    "today's",
    'todays',
    'right now',
    'currently',
    'current',
    'latest',
    'recent',
    'recently',
    'this week',
    'this month',
    'this year',
    'new update',
    'latest update',
    'current update',
    'what is happening',
    'whats happening',
    "what's happening",

    /*
     * Roman Urdu / Urdu-style queries
     */
    'aaj',
    'aj',
    'abhi',
    'filhal',
    'haal hi',
    'naya update',
    'new update',
    'kya chal raha',
    'kya ho raha',
    'kon hai abhi',
    'kaun hai abhi',
    'abhi ka',
    'abhi ki',
    'abhi ke'
  ];

  /*
   * Entertainment / anime / movie / game releases
   */
  const entertainmentTriggers = [
    'release',
    'released',
    'release date',
    'release hua',
    'release hui',
    'release ho gaya',
    'release ho gya',
    'released hai',
    'out now',
    'out ho gaya',
    'out ho gya',
    'available now',
    'available hai',
    'season 2',
    'season 3',
    'season 4',
    'season 5',
    'season 6',
    'season 7',
    'season 8',
    'season 9',
    'season 10',
    'new season',
    'next season',
    'new episode',
    'next episode',
    'episode',
    'episodes',
    'part 2',
    'part 3',
    'movie release',
    'anime release',
    'manga update',
    'chapter',
    'new chapter'
  ];

  /*
   * News / public figures / live information
   */
  const newsTriggers = [
    'news',
    'breaking',
    'headline',
    'president',
    'prime minister',
    'pm of',
    'ceo',
    'election',
    'government',
    'minister',
    'who is the current',
    'who is currently'
  ];

  /*
   * Live data
   */
  const liveDataTriggers = [
    'price',
    'cost',
    'weather',
    'temperature',
    'score',
    'scores',
    'standings',
    'live score',
    'match today',
    'game today',
    'stock',
    'exchange rate',
    'currency rate',
    'bitcoin price'
  ];

  /*
   * Explicit web/search requests
   */
  const explicitSearchTriggers = [
    'search the web',
    'search web',
    'search online',
    'google it',
    'look it up',
    'look this up',
    'find online',
    'check online',
    'check the internet',
    'web search',
    'internet par search',
    'online check karo',
    'search karo',
    'web par dekho'
  ];

  /*
   * Years can indicate time-sensitive questions.
   */
  const yearPattern = /\b20\d{2}\b/;

  if (currentTriggers.some(t => text.includes(t))) return true;
  if (entertainmentTriggers.some(t => text.includes(t))) return true;
  if (newsTriggers.some(t => text.includes(t))) return true;
  if (liveDataTriggers.some(t => text.includes(t))) return true;
  if (explicitSearchTriggers.some(t => text.includes(t))) return true;
  if (yearPattern.test(text)) return true;

  return false;
}

/* =========================================================
   SSE EVENT
========================================================= */

function sseEvent(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/* =========================================================
   TAVILY SEARCH
========================================================= */

async function tavilySearch(query) {
  const key = process.env.TAVILY_API_KEY;

  if (!key) {
    return {
      results: [],
      error: 'TAVILY_API_KEY not configured'
    };
  }

  const response = await fetchWithTimeout(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: 'basic',
        topic: 'general',
        max_results: 5,
        include_answer: false,
        include_raw_content: false
      })
    },
    10000
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `Tavily failed: ${response.status}${errorText ? ` - ${errorText}` : ''}`
    );
  }

  const data = await response.json();

  return {
    results: Array.isArray(data.results)
      ? data.results
      : []
  };
}

/* =========================================================
   BUILD WEB CONTEXT
========================================================= */

function buildWebContext(results) {
  if (!results.length) return '';

  return results
    .map((r, i) => {
      return [
        `[Source ${i + 1}]`,
        `Title: ${r.title || 'Untitled'}`,
        `URL: ${r.url || ''}`,
        `Content: ${r.content || ''}`
      ].join('\n');
    })
    .join('\n\n');
}

/* =========================================================
   PAKISTAN CURRENT DATE/TIME
========================================================= */

function getPakistanDateTime() {
  const now = new Date();

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi',
    dateStyle: 'full',
    timeStyle: 'long'
  }).format(now);
}

/* =========================================================
   MAIN HANDLER
========================================================= */

export default async function handler(req) {

  /* OPTIONS */
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  /* METHOD */
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({
        error: 'Method not allowed'
      }),
      {
        status: 405,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json'
        }
      }
    );
  }

  /* GEMINI KEY */
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: 'GEMINI_API_KEY not configured'
      }),
      {
        status: 500,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json'
        }
      }
    );
  }

  /* PARSE BODY */
  let body;

  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({
        error: 'Invalid JSON'
      }),
      {
        status: 400,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json'
        }
      }
    );
  }

  const {
    contents,
    systemInstruction,
    generationConfig,
    mode
  } = body;

  const modelChain =
    MODEL_CHAIN[mode] || MODEL_CHAIN.fast;

  const userQuery = getLastUserText(contents);

  /*
   * Smart search decision
   */
  const searchNeeded = needsWebSearch(contents);

  /*
   * Current Pakistan date/time
   */
  const pakistanDateTime = getPakistanDateTime();

  let webContext = '';
  let searchError = null;
  let searchResults = [];

  /* =======================================================
     REAL TAVILY SEARCH
  ======================================================= */

  if (searchNeeded && userQuery) {
    try {
      const searchResponse = await tavilySearch(userQuery);

      searchResults = searchResponse.results || [];

      webContext = buildWebContext(searchResults);

      console.log(
        `🌐 Tavily search completed: ${searchResults.length} results`
      );

    } catch (err) {
      searchError =
        err?.message || 'Unknown Tavily error';

      console.error(
        '❌ Tavily search error:',
        searchError
      );
    }
  }

  /* =======================================================
     LIVE INSTRUCTION
  ======================================================= */

  let liveInstruction = `

=== CURRENT DATE AND TIME ===

The current date and time in Pakistan is:

${pakistanDateTime}

Use this as authoritative for:
- today's date
- current month
- current year
- relative dates
- "aaj"
- "abhi"
- "right now"

Never answer these questions using an outdated remembered date.

=== WEB SEARCH DECISION ===

Search needed:
${searchNeeded ? 'YES' : 'NO'}
`;

  if (searchNeeded) {
    liveInstruction += `

This question was detected as potentially time-sensitive or requiring fresh information.
`;

    if (webContext) {
      liveInstruction += `

=== FRESH WEB SOURCES ===

Fresh web search results were retrieved from Tavily.

Use these sources as the primary evidence for current/fresh claims.

IMPORTANT:
- Do not ignore the web sources.
- Do not answer a current question from old model knowledge when the sources provide relevant information.
- If sources disagree, explain the disagreement.
- Do not invent facts that are not supported by the sources.
- Cite factual claims using [Source 1], [Source 2], etc.
- Only cite a source when it actually supports the claim.

WEB SOURCES:

${webContext}
`;
    } else {
      liveInstruction += `

=== WEB SEARCH RESULT ===

The question required web search, but no usable web results were returned.

Do NOT pretend that you successfully searched the web.

Answer only from available knowledge and clearly avoid presenting old knowledge as confirmed current information.
`;
    }
  } else {
    liveInstruction += `

No web search was required for this request.
`;
  }

  if (searchError) {
    liveInstruction += `

=== SEARCH ERROR ===

The web search failed.

Error:
${searchError}

Do not claim that live web information was verified.
`;
  }

  /* =======================================================
     COMBINE SYSTEM INSTRUCTIONS
  ======================================================= */

  const originalInstruction =
    systemInstruction?.parts
      ?.map(p => p.text || '')
      .join('\n') || '';

  const combinedInstruction =
    originalInstruction +
    liveInstruction;

  /* =======================================================
     GEMINI REQUEST
  ======================================================= */

  const geminiBody = {
    contents,
    systemInstruction: {
      parts: [
        {
          text: combinedInstruction
        }
      ]
    },
    generationConfig
  };

  /* =======================================================
     STREAM RESPONSE
  ======================================================= */

  const encoder = new TextEncoder();

  const stream = new ReadableStream({

    async start(controller) {

      const send = obj => {
        controller.enqueue(
          encoder.encode(
            sseEvent(obj)
          )
        );
      };

      try {

        /*
         * THINKING STATUS
         */

        send({
          type: 'status',
          status: searchNeeded
            ? '🧠 Thinking... → 🌐 Searching the web...'
            : '🧠 Thinking...'
        });

        /*
         * SEARCH STATUS
         */

        if (searchNeeded) {

          if (searchResults.length > 0) {

            send({
              type: 'status',
              status:
                '🔎 Checking sources...'
            });

            send({
              type: 'status',
              status:
                '🧠 Analyzing sources...'
            });

          } else {

            send({
              type: 'status',
              status:
                '🔎 Search unavailable → 🧠 Using available knowledge...'
            });

          }
        }

        /*
         * WRITING
         */

        send({
          type: 'status',
          status: '✍️ Writing answer...'
        });

        /* =================================================
           MODEL FALLBACK CHAIN
        ================================================= */

        let lastError = null;

        const startTime = Date.now();

        for (const modelName of modelChain) {

          const url =
            `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

          try {

            console.log(
              `⚡ Trying model: ${modelName} | elapsed: ${Date.now() - startTime}ms`
            );

            const geminiRes =
              await fetchWithTimeout(
                url,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type':
                      'application/json'
                  },
                  body:
                    JSON.stringify(geminiBody)
                },
                15000
              );

            if (geminiRes.ok) {

              const reader =
                geminiRes.body.getReader();

              while (true) {

                const {
                  value,
                  done
                } = await reader.read();

                if (done) break;

                controller.enqueue(value);
              }

              controller.close();

              return;
            }

            const errorBody =
              await geminiRes
                .text()
                .catch(() => '');

            lastError =
              new Error(
                `Model ${modelName} failed: ${geminiRes.status}${errorBody ? ` - ${errorBody}` : ''}`
              );

            console.error(
              lastError.message
            );

          } catch (err) {

            lastError = err;

            console.error(
              `❌ ${modelName} error:`,
              err?.message
            );
          }
        }

        /* =================================================
           ALL MODELS FAILED
        ================================================= */

        send({
          error:
            'All models failed. Please try again.',
          details:
            lastError?.message ||
            'Unknown error'
        });

        controller.close();

      } catch (err) {

        try {

          send({
            error:
              err?.message ||
              'Server error'
          });

        } catch (_) {}

        controller.close();
      }
    }
  });

  /* =======================================================
     RESPONSE
  ======================================================= */

  return new Response(stream, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type':
        'text/event-stream; charset=utf-8',
      'Cache-Control':
        'no-cache, no-transform',
      'Connection':
        'keep-alive',
      'X-Accel-Buffering':
        'no'
    }
  });
}