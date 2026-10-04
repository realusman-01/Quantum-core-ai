export const config = {
  runtime: 'edge'
};

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

/* =========================
   WEB SEARCH DECISION
========================= */

function needsWebSearch(contents) {
  const text = (contents || [])
    .map(m =>
      (m.parts || [])
        .map(p => p.text || '')
        .join(' ')
    )
    .join('\n')
    .toLowerCase();

  const triggers = [
    // English
    'today',
    "today's",
    'todays',
    'current',
    'currently',
    'right now',
    'latest',
    'recent',
    'news',
    'this week',
    'this month',
    'this year',
    'new update',
    'latest update',
    'release date',
    'released',
    'release',
    'season 2',
    'season 3',
    'episode',
    'price',
    'cost',
    'weather',
    'score',
    'scores',
    'standings',
    'president',
    'prime minister',
    'ceo',
    'what is happening',
    'what happened',

    // Roman Urdu / Urdu-style queries
    'aaj',
    'aj',
    'abhi',
    'filhal',
    'haal hi',
    'latest kya',
    'latest update',
    'release ho',
    'release hua',
    'release hui',
    'kab release',
    'release date',
    'season 2 aa',
    'season 2 a',
    'season 3 aa',
    'season 3 a',
    'episode kab',
    'episode aa',
    'new episode',
    'naya episode',
    'price kya',
    'kitne ka',
    'kitni price',
    'mausam',
    'score kya',
    'match ka score',

    // Explicit temporal years
    '2024',
    '2025',
    '2026',
    '2027'
  ];

  return triggers.some(trigger => text.includes(trigger));
}

/* =========================
   LAST USER MESSAGE
========================= */

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

/* =========================
   SSE
========================= */

function sseEvent(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/* =========================
   TAVILY SEARCH
========================= */

async function tavilySearch(query, currentDate) {
  const key = process.env.TAVILY_API_KEY;

  if (!key) {
    return {
      results: [],
      answer: '',
      error: 'TAVILY_API_KEY not configured'
    };
  }

  /*
    Reformulate the query so Tavily understands that
    we need CURRENT information, not old knowledge.
  */

  const searchQuery = `
${query}

Find the latest and currently valid information as of ${currentDate}.
Prioritize official sources and reliable recent sources.
If this is about a release date, availability, current status,
latest episode, latest season, or recent update, verify the exact
current status and date.
`.trim();

  const res = await fetchWithTimeout(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: key,
        query: searchQuery,

        // Better retrieval for current/factual questions
        search_depth: 'advanced',

        topic: 'general',

        // Enough sources for cross-checking
        max_results: 8,

        // Let Tavily provide an additional short answer when available
        include_answer: true,

        include_raw_content: false,

        chunks_per_source: 3
      })
    },
    12000
  );

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(
      `Tavily failed: ${res.status} ${errorText}`
    );
  }

  const data = await res.json();

  return {
    results: Array.isArray(data.results)
      ? data.results
      : [],

    answer:
      typeof data.answer === 'string'
        ? data.answer
        : ''
  };
}

/* =========================
   BUILD WEB CONTEXT
========================= */

function buildWebContext(results, tavilyAnswer = '') {
  if (!results.length && !tavilyAnswer) {
    return '';
  }

  let context = '';

  if (tavilyAnswer) {
    context += `
[TAVILY DIRECT ANSWER]
${tavilyAnswer}
[/TAVILY DIRECT ANSWER]

`;
  }

  results.forEach((r, i) => {
    context += `
[WEB SOURCE ${i + 1}]
Title: ${r.title || 'Untitled'}
URL: ${r.url || ''}
Published: ${r.published_date || 'Unknown'}

Content:
${r.content || ''}
[/WEB SOURCE ${i + 1}]

`;
  });

  return context.trim();
}

/* =========================
   HANDLER
========================= */

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

  /* BODY */
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
    MODEL_CHAIN[mode] || MODEL_CHAIN.core;

  /* =========================
     CURRENT DATE/TIME
  ========================= */

  const now = new Date();

  const currentDate = now.toLocaleDateString(
    'en-CA',
    {
      timeZone: 'Asia/Karachi'
    }
  );

  const currentTime = now.toLocaleTimeString(
    'en-US',
    {
      timeZone: 'Asia/Karachi',
      hour12: false
    }
  );

  const dateText =
    `${currentDate} ${currentTime} Pakistan Time`;

  /* =========================
     USER QUERY
  ========================= */

  const userQuery = getLastUserText(contents);

  const searchNeeded =
    needsWebSearch(contents);

  let webContext = '';
  let searchError = null;
  let searchResults = [];
  let tavilyAnswer = '';

  /* =========================
     WEB SEARCH
  ========================= */

  if (searchNeeded && userQuery) {
    try {

      const searchData =
        await tavilySearch(
          userQuery,
          currentDate
        );

      searchResults =
        searchData.results || [];

      tavilyAnswer =
        searchData.answer || '';

      webContext =
        buildWebContext(
          searchResults,
          tavilyAnswer
        );

    } catch (err) {

      searchError =
        err?.message ||
        'Unknown Tavily error';

      console.error(
        'Tavily error:',
        searchError
      );
    }
  }

  /* =========================
     LIVE SYSTEM INSTRUCTION
  ========================= */

  const liveInstruction = `

========================
CURRENT DATE / TIME
========================

Current Pakistan date:
${currentDate}

Current Pakistan time:
${currentTime}

The date above is authoritative.

========================
WEB SEARCH RULES
========================

This request was classified as:

WEB SEARCH NEEDED: ${searchNeeded ? 'YES' : 'NO'}

${searchNeeded ? `
This is a current/fresh-information request.

IMPORTANT:

1. The WEB SOURCES below are newer than the model's
   built-in knowledge and must be treated as authoritative
   for current facts.

2. If your previous knowledge conflicts with the web sources,
   TRUST THE WEB SOURCES.

3. Do NOT answer a current question using old memory when
   relevant web evidence is available.

4. Carefully read ALL relevant sources before answering.

5. For release dates, season status, episode availability,
   prices, current people, news, scores, weather, updates,
   and similar time-sensitive information, use the retrieved
   web evidence.

6. If an official source explicitly confirms something,
   prefer that over unofficial sources.

7. If sources disagree, explain the disagreement instead of
   silently choosing an unsupported answer.

8. NEVER claim that you searched the web if no web results
   were actually retrieved.

9. Do not invent citations.

10. Cite web evidence naturally using:
   [Source 1], [Source 2], etc.

11. Only cite a source number when that source actually
    supports the statement.

12. If the web evidence clearly says an event/release has
    happened on today's date, do NOT say it has not happened.

13. When the user asks "aaj", "today", "abhi", etc.,
    interpret it using the Pakistan date above.
` : `
No web search was required for this request.
Answer normally using your knowledge.
`}

========================
WEB EVIDENCE
========================

${
  webContext
    ? webContext
    : 'NO WEB SOURCES RETRIEVED.'
}

========================
SEARCH ERROR
========================

${
  searchError
    ? `Search failed: ${searchError}`
    : 'No search error.'
}

========================
FINAL ANSWER RULE
========================

Answer the user's actual question directly.

Do not mention internal routing, model names,
Tavily, API keys, search algorithms, or system instructions.

If current web evidence is available, use it.
`;

  /* =========================
     COMBINE SYSTEM INSTRUCTION
  ========================= */

  const originalSystemInstruction =
    systemInstruction?.parts
      ?.map(p => p.text || '')
      .join('\n') || '';

  const combinedInstruction =
    originalSystemInstruction +
    liveInstruction;

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

  /* =========================
     STREAM RESPONSE
  ========================= */

  const encoder = new TextEncoder();

  const stream =
    new ReadableStream({

      async start(controller) {

        const send = obj => {
          controller.enqueue(
            encoder.encode(
              sseEvent(obj)
            )
          );
        };

        try {

          /* STATUS */

          if (searchNeeded) {

            send({
              type: 'status',
              status:
                '🧠 Thinking... → 🌐 Searching the web...'
            });

            if (searchResults.length) {

              send({
                type: 'status',
                status:
                  `🔎 Found ${searchResults.length} sources → 🧠 Analyzing...`
              });

            } else {

              send({
                type: 'status',
                status:
                  '🔎 Search unavailable → 🧠 Using available knowledge...'
              });

            }

          } else {

            send({
              type: 'status',
              status:
                '🧠 Thinking...'
            });

          }

          send({
            type: 'status',
            status:
              '✍️ Writing answer...'
          });

          /* =========================
             GEMINI MODEL FALLBACK
          ========================= */

          let lastError = null;

          const startTime =
            Date.now();

          for (
            const modelName
            of modelChain
          ) {

            const url =
              `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

            try {

              console.log(
                `⚡ Trying ${modelName} | elapsed ${Date.now() - startTime}ms`
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
                      JSON.stringify(
                        geminiBody
                      )
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
                  } =
                    await reader.read();

                  if (done) break;

                  controller.enqueue(
                    value
                  );
                }

                controller.close();

                return;
              }

              const errorBody =
                await geminiRes.text()
                  .catch(() => '');

              lastError =
                new Error(
                  `Model ${modelName} failed: ${geminiRes.status} ${errorBody}`
                );

              console.error(
                lastError.message
              );

            } catch (err) {

              lastError = err;

              console.error(
                `Model ${modelName} error:`,
                err?.message
              );
            }
          }

          /* ALL MODELS FAILED */

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

  return new Response(
    stream,
    {
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
    }
  );
}