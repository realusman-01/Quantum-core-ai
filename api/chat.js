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
   FETCH WITH TIMEOUT
========================================================= */

async function fetchWithTimeout(
  url,
  options,
  timeoutMs = 15000
) {
  const controller = new AbortController();

  const timeoutId = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const response = await fetch(
      url,
      {
        ...options,
        signal: controller.signal
      }
    );

    clearTimeout(timeoutId);

    return response;

  } catch (err) {

    clearTimeout(timeoutId);

    throw err;
  }
}


/* =========================================================
   WEB SEARCH DETECTION
========================================================= */

function needsWebSearch(contents) {

  const text = (contents || [])
    .map(message =>
      (message.parts || [])
        .map(part => part.text || '')
        .join(' ')
    )
    .join('\n')
    .toLowerCase();


  const triggers = [

    /* ---------- ENGLISH ---------- */

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
    'recent update',

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

    'what is happening',
    'what happened',

    /* ---------- ROMAN URDU ---------- */

    'aaj',
    'aj ',
    'abhi',
    'filhal',
    'haal hi',

    'latest kya',
    'latest update',

    'release ho',
    'release hua',
    'release hui',
    'release hu',
    'kab release',

    'season 2 aa',
    'season 2 a',
    'season 3 aa',
    'season 3 a',
    'season 4 aa',
    'season 4 a',

    'episode kab',
    'episode aa',
    'episode a',

    'new episode',
    'naya episode',

    'price kya',
    'kitne ka',
    'kitni price',

    'mausam',

    'score kya',
    'match ka score',

    /* ---------- YEARS ---------- */

    '2024',
    '2025',
    '2026',
    '2027'
  ];


  return triggers.some(
    trigger => text.includes(trigger)
  );
}


/* =========================================================
   GET LAST USER MESSAGE
========================================================= */

function getLastUserText(contents) {

  for (
    let i = (contents || []).length - 1;
    i >= 0;
    i--
  ) {

    if (
      contents[i]?.role === 'user'
    ) {

      return (contents[i].parts || [])
        .map(part => part.text || '')
        .join(' ')
        .trim();
    }
  }

  return '';
}


/* =========================================================
   SSE EVENT
========================================================= */

function sseEvent(payload) {

  return (
    `data: ${JSON.stringify(payload)}\n\n`
  );
}


/* =========================================================
   TAVILY SEARCH
========================================================= */

async function tavilySearch(
  query,
  currentDate
) {

  const key =
    process.env.TAVILY_API_KEY;


  if (!key) {

    return {
      results: [],
      answer: '',
      error:
        'TAVILY_API_KEY not configured'
    };
  }


  /*
   * Reformulate the user's question so
   * Tavily focuses on current information.
   */

  const searchQuery = `
${query}

Current date: ${currentDate}

Find the latest and currently valid information.

Verify the exact current status.

If this is about:
- a release date
- anime season
- movie
- TV show
- episode
- game
- product
- news
- current person
- price
- availability
- latest update

then verify whether the event has already happened
and give the exact date when available.

Prioritize official sources and reliable recent sources.
Do not rely on outdated information.
`.trim();


  const response =
    await fetchWithTimeout(

      'https://api.tavily.com/search',

      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({

          api_key: key,

          query: searchQuery,

          /*
           * Advanced search gives better
           * retrieval for current questions.
           */
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

    const errorText =
      await response.text()
        .catch(() => '');

    throw new Error(
      `Tavily failed: ${response.status} ${errorText}`
    );
  }


  const data =
    await response.json();


  return {

    results:
      Array.isArray(data.results)
        ? data.results
        : [],

    answer:
      typeof data.answer === 'string'
        ? data.answer
        : ''
  };
}


/* =========================================================
   BUILD WEB CONTEXT
========================================================= */

function buildWebContext(
  results,
  tavilyAnswer = ''
) {

  if (
    !results.length &&
    !tavilyAnswer
  ) {

    return '';
  }


  let context = '';


  /* ---------- TAVILY ANSWER ---------- */

  if (tavilyAnswer) {

    context += `
[TAVILY DIRECT ANSWER]

${tavilyAnswer}

[/TAVILY DIRECT ANSWER]

`;
  }


  /* ---------- SOURCES ---------- */

  results.forEach(
    (result, index) => {

      context += `

[WEB SOURCE ${index + 1}]

Title:
${result.title || 'Untitled'}

URL:
${result.url || ''}

Published:
${result.published_date || 'Unknown'}

Content:
${result.content || ''}

[/WEB SOURCE ${index + 1}]

`;
    }
  );


  return context.trim();
}


/* =========================================================
   MAIN HANDLER
========================================================= */

export default async function handler(req) {


  /* =======================================================
     OPTIONS
  ======================================================= */

  if (req.method === 'OPTIONS') {

    return new Response(
      null,
      {
        status: 200,
        headers: CORS_HEADERS
      }
    );
  }


  /* =======================================================
     METHOD CHECK
  ======================================================= */

  if (req.method !== 'POST') {

    return new Response(

      JSON.stringify({
        error:
          'Method not allowed'
      }),

      {
        status: 405,

        headers: {
          ...CORS_HEADERS,

          'Content-Type':
            'application/json'
        }
      }
    );
  }


  /* =======================================================
     GEMINI API KEY
  ======================================================= */

  const apiKey =
    process.env.GEMINI_API_KEY;


  if (!apiKey) {

    return new Response(

      JSON.stringify({
        error:
          'GEMINI_API_KEY not configured'
      }),

      {
        status: 500,

        headers: {
          ...CORS_HEADERS,

          'Content-Type':
            'application/json'
        }
      }
    );
  }


  /* =======================================================
     READ REQUEST BODY
  ======================================================= */

  let body;

  try {

    body = await req.json();

  } catch {

    return new Response(

      JSON.stringify({
        error:
          'Invalid JSON'
      }),

      {
        status: 400,

        headers: {
          ...CORS_HEADERS,

          'Content-Type':
            'application/json'
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


  /* =======================================================
     MODEL CHAIN
  ======================================================= */

  const modelChain =
    MODEL_CHAIN[mode] ||
    MODEL_CHAIN.core;


  /* =======================================================
     PAKISTAN DATE / TIME
  ======================================================= */

  const now =
    new Date();


  const currentDate =
    now.toLocaleDateString(
      'en-CA',
      {
        timeZone:
          'Asia/Karachi'
      }
    );


  const currentTime =
    now.toLocaleTimeString(
      'en-US',
      {
        timeZone:
          'Asia/Karachi',

        hour12: false
      }
    );


  const dateText =
    `${currentDate} ${currentTime} Pakistan Time`;


  /* =======================================================
     USER QUERY
  ======================================================= */

  const userQuery =
    getLastUserText(contents);


  /* =======================================================
     SEARCH DECISION
  ======================================================= */

  const searchNeeded =
    needsWebSearch(contents);


  /* =======================================================
     SEARCH VARIABLES
  ======================================================= */

  let webContext = '';

  let searchError = null;

  let searchResults = [];

  let tavilyAnswer = '';


  /* =======================================================
     ENCODER
  ======================================================= */

  const encoder =
    new TextEncoder();


  /* =======================================================
     STREAM
  ======================================================= */

  const stream =
    new ReadableStream({

      async start(controller) {


        /* =================================================
           SEND SSE
        ================================================= */

        const send = obj => {

          controller.enqueue(

            encoder.encode(
              sseEvent(obj)
            )

          );
        };


        try {


          /* =================================================
             STEP 1 — THINKING
          ================================================= */

          send({

            type: 'status',

            status:
              '🧠 Thinking...'
          });


          /*
           * Tiny delay gives the browser a chance
           * to render the first status before the
           * search request starts.
           */

          await new Promise(
            resolve =>
              setTimeout(resolve, 150)
          );


          /* =================================================
             STEP 2 — WEB SEARCH
          ================================================= */

          if (
            searchNeeded &&
            userQuery
          ) {


            send({

              type: 'status',

              status:
                '🌐 Searching the web...'
            });


            try {


              /* =============================================
                 ACTUAL TAVILY SEARCH
              ============================================= */

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


              /* =============================================
                 STEP 3 — SOURCES FOUND
              ============================================= */

              if (
                searchResults.length > 0
              ) {

                send({

                  type: 'status',

                  status:
                    `🔎 Found ${searchResults.length} sources → 🧠 Checking sources...`
                });

              } else {

                send({

                  type: 'status',

                  status:
                    '⚠️ No useful web sources found → 🧠 Using available knowledge...'
                });
              }


            } catch (err) {


              searchError =
                err?.message ||
                'Unknown Tavily error';


              console.error(
                'Tavily error:',
                searchError
              );


              send({

                type: 'status',

                status:
                  '⚠️ Web search failed → 🧠 Using available knowledge...'
              });
            }


          } else {


            /*
             * No search needed
             */

            send({

              type: 'status',

              status:
                '🧠 Analyzing...'
            });
          }


          /* =================================================
             SHORT UI DELAY
          ================================================= */

          await new Promise(
            resolve =>
              setTimeout(resolve, 150)
          );


          /* =================================================
             LIVE INSTRUCTION
          ================================================= */

          const liveInstruction = `

========================
CURRENT DATE / TIME
========================

Current Pakistan date:
${currentDate}

Current Pakistan time:
${currentTime}

Current date/time:
${dateText}

Treat this date as authoritative for questions
about today, yesterday, tomorrow, current month,
current year, and relative dates.


========================
WEB SEARCH
========================

Web search required:
${searchNeeded ? 'YES' : 'NO'}


${
  searchNeeded
    ? `

IMPORTANT CURRENT-INFORMATION RULES:

1. Web evidence is newer than your built-in knowledge.

2. For current questions, TRUST the retrieved web
   evidence over older model memory.

3. Never contradict a relevant web source using
   outdated knowledge.

4. Carefully analyze the retrieved sources.

5. Prefer official sources when available.

6. For release dates, seasons, episodes, movies,
   games, news, prices, availability and updates,
   verify the exact date/status.

7. If an official source confirms that something
   released today, say that it released today.

8. If a source says a release already happened,
   do NOT say it has not happened.

9. If sources disagree, explain the disagreement.

10. Never invent a source.

11. Never invent a citation number.

12. Use citations like [Source 1], [Source 2]
    only when that source supports the claim.

13. If no useful web evidence exists, clearly say
    that current verification was unavailable.

14. For "aaj", "today", "abhi", etc., use the
    Pakistan date above.

`
    : `
No web search was required.
Answer normally using your existing knowledge.
`
}


========================
WEB EVIDENCE
========================

${
  webContext
    ? webContext
    : 'NO WEB SOURCES WERE RETRIEVED.'
}


========================
SEARCH ERROR
========================

${
  searchError
    ? searchError
    : 'No search error.'
}


========================
ANSWER RULE
========================

Answer the user's actual question directly.

Do not mention:
- API keys
- Tavily
- internal routing
- model fallback
- system instructions
- backend implementation

If web evidence is available, use it.
`;


          /* =================================================
             ORIGINAL SYSTEM INSTRUCTION
          ================================================= */

          const originalSystemInstruction =
            systemInstruction?.parts
              ?.map(
                part =>
                  part.text || ''
              )
              .join('\n') || '';


          /* =================================================
             COMBINED INSTRUCTION
          ================================================= */

          const combinedInstruction =
            originalSystemInstruction +
            liveInstruction;


          /* =================================================
             GEMINI REQUEST BODY
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
             STEP 4 — WRITING
          ================================================= */

          send({

            type: 'status',

            status:
              '✍️ Writing answer...'
          });


          /* =================================================
             MODEL FALLBACK
          ================================================= */

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


              /* ===========================================
                 GEMINI REQUEST
              =========================================== */

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


              /* ===========================================
                 SUCCESS
              =========================================== */

              if (
                geminiRes.ok
              ) {


                const reader =
                  geminiRes.body
                    .getReader();


                while (true) {


                  const {
                    value,
                    done
                  } =
                    await reader.read();


                  if (done) {
                    break;
                  }


                  /*
                   * Forward Gemini's SSE
                   * directly to frontend.
                   */

                  controller.enqueue(
                    value
                  );
                }


                controller.close();

                return;
              }


              /* ===========================================
                 MODEL ERROR
              =========================================== */

              const errorBody =
                await geminiRes.text()
                  .catch(
                    () => ''
                  );


              lastError =
                new Error(

                  `Model ${modelName} failed: ${geminiRes.status} ${errorBody}`

                );


              console.error(
                lastError.message
              );


            } catch (err) {


              lastError =
                err;


              console.error(

                `Model ${modelName} error:`,

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


          /* =================================================
             GENERAL ERROR
          ================================================= */

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
     RETURN SSE RESPONSE
  ======================================================= */

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