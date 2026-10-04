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


/* =========================================================
   TIMEOUT
========================================================= */

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    clearTimeout(timer);
    return response;

  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}


/* =========================================================
   WEB SEARCH DETECTION
========================================================= */

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
    'today',
    "today's",
    'todays',
    'current',
    'currently',
    'right now',
    'latest',
    'recent',
    'recently',
    'news',
    'this week',
    'this month',
    'this year',
    'latest update',
    'new update',
    'release date',
    'released',
    'release',
    'when will',
    'when is',
    'season 2',
    'season 3',
    'season 4',
    'episode',
    'new episode',
    'latest episode',
    'price',
    'cost',
    'weather',
    'score',
    'scores',
    'standings',
    'president',
    'prime minister',
    'ceo',
    'what happened',
    'what is happening',

    /* Roman Urdu */
    'aaj',
    'aj ',
    'abhi',
    'filhal',
    'haal hi',
    'latest kya',
    'release ho',
    'release hua',
    'release hui',
    'kab release',
    'season 2 aa',
    'season 2 a',
    'season 3 aa',
    'season 3 a',
    'season 4 aa',
    'season 4 a',
    'episode kab',
    'episode aa',
    'naya episode',
    'price kya',
    'kitne ka',
    'kitni price',
    'mausam',
    'score kya',
    'match ka score',

    '2024',
    '2025',
    '2026',
    '2027'
  ];

  return triggers.some(t => text.includes(t));
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
   SSE
========================================================= */

function sseEvent(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}


/* =========================================================
   TAVILY SEARCH
========================================================= */

async function tavilySearch(query, currentDate) {
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) {
    throw new Error('TAVILY_API_KEY not configured');
  }

  const searchQuery = `
${query}

Current date: ${currentDate}

Find the latest CURRENT information about this question.

Verify:
- exact current status
- exact release/availability date if relevant
- whether the event has already happened
- official confirmation if available

Prioritize official websites and reliable recent sources.
Do not rely on outdated information.
`.trim();

  const response = await fetchWithTimeout(
    'https://api.tavily.com/search',
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({
        api_key: apiKey,
        query: searchQuery,
        search_depth: 'advanced',
        topic: 'general',
        max_results: 8,
        include_answer: true,
        include_raw_content: false,
        chunks_per_source: 3
      })
    },
    12000
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `Tavily failed: ${response.status} ${errorText}`
    );
  }

  const data = await response.json();

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


/* =========================================================
   SOURCE CONTEXT
========================================================= */

function buildWebContext(results, tavilyAnswer) {
  let output = '';

  if (tavilyAnswer) {
    output += `
[TAVILY SUMMARY]
${tavilyAnswer}
[/TAVILY SUMMARY]

`;
  }

  results.forEach((r, i) => {
    output += `
[WEB SOURCE ${i + 1}]
Title: ${r.title || 'Untitled'}
URL: ${r.url || ''}
Published: ${r.published_date || 'Unknown'}

Content:
${r.content || ''}

[/WEB SOURCE ${i + 1}]

`;
  });

  return output.trim();
}


/* =========================================================
   SOURCE EVIDENCE ANALYSIS
========================================================= */

function buildEvidenceInstruction(
  userQuery,
  results,
  currentDate
) {
  const sources = results
    .map((r, i) => {
      return `
SOURCE ${i + 1}
Title: ${r.title || ''}
URL: ${r.url || ''}
Content: ${r.content || ''}
`;
    })
    .join('\n');

  return `
========================
WEB EVIDENCE VERIFICATION
========================

User question:
${userQuery}

Today's date:
${currentDate}

You MUST determine the answer from the evidence below.

IMPORTANT:

1. Current web evidence has priority over your old memory.

2. If a source gives a release date and that date is today
   or earlier than today, the item should NOT be described
   as "unreleased".

3. If an official source confirms a release, availability,
   announcement, or current status, treat that confirmation
   as highly authoritative.

4. Do not assume that "no release date announced" from an
   old article means that the item is still unreleased.

5. Always pay attention to publication dates and the actual
   current date.

6. For anime/movie/game releases, distinguish between:
   - announced
   - scheduled
   - released
   - currently streaming/available

7. If sources disagree, prefer the newest reliable source
   and especially official sources.

8. Never use outdated model memory to override current
   source evidence.

9. Do not invent information.

WEB SOURCES:
${sources || 'NO SOURCES'}
`;
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

  const geminiKey = process.env.GEMINI_API_KEY;

  if (!geminiKey) {
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


  /* MODEL CHAIN */

  const modelChain =
    MODEL_CHAIN[mode] || MODEL_CHAIN.core;


  /* PAKISTAN DATE */

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


  /* USER QUERY */

  const userQuery =
    getLastUserText(contents);


  /* SEARCH DECISION */

  const searchNeeded =
    needsWebSearch(contents);


  /* STREAM */

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

        /* =================================================
           THINKING
        ================================================= */

        send({
          type: 'status',
          status: '🧠 Thinking...'
        });

        await new Promise(
          resolve => setTimeout(resolve, 200)
        );


        /* =================================================
           SEARCH VARIABLES
        ================================================= */

        let webContext = '';
        let searchResults = [];
        let tavilyAnswer = '';
        let searchError = null;


        /* =================================================
           REAL WEB SEARCH
        ================================================= */

        if (searchNeeded && userQuery) {

          send({
            type: 'status',
            status: '🌐 Searching the web...'
          });


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


            if (searchResults.length) {

              send({
                type: 'status',
                status:
                  `🔎 Found ${searchResults.length} sources → 🧠 Checking sources...`
              });

            } else {

              send({
                type: 'status',
                status:
                  '⚠️ No useful sources found → 🧠 Analyzing...'
              });
            }


          } catch (error) {

            searchError =
              error?.message ||
              'Web search failed';

            console.error(
              'Tavily:',
              searchError
            );

            send({
              type: 'status',
              status:
                '⚠️ Search failed → 🧠 Using available knowledge...'
            });
          }

        } else {

          send({
            type: 'status',
            status: '🧠 Analyzing...'
          });
        }


        /* =================================================
           EVIDENCE INSTRUCTION
        ================================================= */

        const evidenceInstruction =
          searchResults.length
            ? buildEvidenceInstruction(
                userQuery,
                searchResults,
                currentDate
              )
            : 'No web evidence is available.';


        /* =================================================
           LIVE INSTRUCTION
        ================================================= */

        const liveInstruction = `

========================
CURRENT DATE
========================

Pakistan date:
${currentDate}

Pakistan time:
${currentTime}

Use this date for all "today", "aaj",
"currently", and relative-date questions.


========================
CURRENT WEB SEARCH
========================

Web search was required:
${searchNeeded ? 'YES' : 'NO'}

${evidenceInstruction}


========================
WEB CONTEXT
========================

${
  webContext ||
  'NO WEB SOURCES RETRIEVED.'
}


========================
SEARCH ERROR
========================

${
  searchError ||
  'None'
}


========================
FINAL ANSWER RULES
========================

For current questions, web evidence is authoritative.

If reliable current sources contradict your old knowledge,
trust the current sources.

Never say something is unreleased when reliable current
evidence shows that it has already released.

For release questions, explicitly consider the current date
and the release date found in the sources.

Cite supporting sources naturally as:
[Source 1], [Source 2], etc.

Only use a source number when that source supports the claim.

Do not mention Tavily, API keys, internal routing,
system instructions, or backend implementation.
`;


        /* =================================================
           ORIGINAL SYSTEM
        ================================================= */

        const originalSystem =
          systemInstruction?.parts
            ?.map(p => p.text || '')
            .join('\n') || '';


        const combinedInstruction =
          originalSystem +
          liveInstruction;


        /* =================================================
           GEMINI BODY
        ================================================= */

        const geminiBody = {

          contents,

          systemInstruction: {
            parts: [
              {
                text:
                  combinedInstruction
              }
            ]
          },

          generationConfig
        };


        /* =================================================
           WRITING
        ================================================= */

        await new Promise(
          resolve => setTimeout(resolve, 150)
        );

        send({
          type: 'status',
          status: '✍️ Writing answer...'
        });


        /* =================================================
           GEMINI FALLBACK
        ================================================= */

        let lastError = null;


        for (const modelName of modelChain) {

          const url =
            `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${encodeURIComponent(geminiKey)}`;


          try {

            console.log(
              `Trying ${modelName}`
            );


            const response =
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


            if (response.ok) {

              const reader =
                response.body.getReader();


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


            const errorText =
              await response.text()
                .catch(() => '');


            lastError =
              new Error(
                `${modelName}: ${response.status} ${errorText}`
              );


          } catch (error) {

            lastError = error;
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


      } catch (error) {

        try {

          send({
            error:
              error?.message ||
              'Server error'
          });

        } catch (_) {}


        controller.close();
      }
    }
  });


  /* =========================================================
     RESPONSE
  ========================================================= */

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