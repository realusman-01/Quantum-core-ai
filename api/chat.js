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
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json'
    }
  });
}


function sseEvent(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}


async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 15000
) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
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
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}


function getPakistanDateTime() {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Karachi',
      dateStyle: 'full',
      timeStyle: 'long'
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

    const text = parts
      .map(part => {
        if (typeof part?.text === 'string') {
          return part.text;
        }

        return '';
      })
      .join(' ')
      .trim();

    if (text) return text;
  }

  return '';
}


/* =========================================================
   WEB SEARCH DETECTION
   ========================================================= */

function needsWebSearch(contents = []) {
  const text = contents
    .map(item => {
      return (item?.parts || [])
        .map(part => part?.text || '')
        .join(' ');
    })
    .join(' ')
    .toLowerCase();

  const triggers = [

    /* English */
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
    'breaking',
    'this week',
    'this month',
    'this year',
    'release date',
    'released',
    'release',
    'new episode',
    'new season',
    'season 2',
    'season 3',
    'update',
    'latest update',
    'new update',
    'price',
    'weather',
    'score',
    'scores',
    'standings',
    'schedule',
    'president',
    'prime minister',
    'ceo',
    'who is the current',
    'what is happening',
    'when is',
    'when will',
    'is it out',
    'is it released',
    'has it released',
    'available now',
    'streaming now',

    /* Roman Urdu */
    'aaj',
    'abhi',
    'filhal',
    'haal hi',
    'latest',
    'nayi khabar',
    'new khabar',
    'release kab',
    'release date',
    'release ho gaya',
    'release hogaya',
    'release hui',
    'release hu',
    'aa gaya',
    'aa gya',
    'available hai',
    'mil raha',
    'mil rahi',
    'season 2',
    'season 3',
    'episode',
    'new episode',
    'update kya',
    'latest update',
    'kya scene hai',
    'kya status hai',
    'current status',
    'abhi ka status',
    'is waqt',

    /* Years */
    '2026',
    '2027',
    '2025',
    '2024'
  ];

  return triggers.some(trigger => text.includes(trigger));
}


/* =========================================================
   SPECIAL QUERY TYPES
   ========================================================= */

function isReleaseQuestion(text = '') {
  const t = text.toLowerCase();

  const releaseWords = [
    'release',
    'released',
    'release date',
    'premiere',
    'premieres',
    'available',
    'streaming',
    'season 2',
    'season 3',
    'episode'
  ];

  return releaseWords.some(word => t.includes(word));
}


/* =========================================================
   TAVILY SEARCH
   ========================================================= */

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
    Search query ko thora strengthen kar rahe hain.

    Example:
    User: Blue Box season 2 kab release hua?

    Tavily ko:
    - latest
    - official
    - current date
    - release status

    sab ka context milta hai.
  */

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

        headers: {
          'Content-Type': 'application/json'
        },

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
        results: [],
        answer: '',
        error: `Tavily HTTP ${response.status}: ${errorText}`
      };
    }

    const data = await response.json();

    return {
      results: Array.isArray(data?.results)
        ? data.results
        : [],

      answer:
        typeof data?.answer === 'string'
          ? data.answer
          : '',

      error: null
    };

  } catch (error) {
    return {
      results: [],
      answer: '',
      error:
        error?.name === 'AbortError'
          ? 'Tavily search timed out'
          : String(error?.message || error)
    };
  }
}


/* =========================================================
   BUILD WEB EVIDENCE
   ========================================================= */

function buildWebContext(results = [], tavilyAnswer = '') {
  let output = '';

  if (tavilyAnswer) {
    output += `
TAVILY SEARCH SUMMARY:
${tavilyAnswer}

`;
  }

  if (!results.length) {
    return output || 'No web evidence was returned.';
  }

  output += `
WEB SOURCES:
`;

  results.forEach((result, index) => {
    const title = result?.title || 'Untitled source';
    const url = result?.url || '';
    const content =
      result?.content ||
      result?.snippet ||
      '';

    output += `

SOURCE ${index + 1}
Title: ${title}
URL: ${url}
Content:
${content}
`;
  });

  return output;
}


/* =========================================================
   GEMINI REQUEST
   ========================================================= */

async function geminiGenerate(
  model,
  body,
  timeoutMs = 20000
) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${model}:generateContent?key=${encodeURIComponent(key)}`;

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify(body)
    },
    timeoutMs
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Gemini ${model} HTTP ${response.status}: ${errorText}`
    );
  }

  return await response.json();
}


/* =========================================================
   EXTRACT GEMINI TEXT
   ========================================================= */

function extractGeminiText(data) {
  try {
    return (
      data?.candidates?.[0]?.content?.parts
        ?.map(part => part?.text || '')
        .join('')
        .trim() || ''
    );
  } catch {
    return '';
  }
}


/* =========================================================
   JSON EXTRACTION
   ========================================================= */

function extractJson(text) {
  if (!text) return null;

  let cleaned = text.trim();

  /*
    Markdown JSON block remove
  */

  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/i, '')
      .trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    /* Continue below */
  }

  /*
    First { ... } object find karne ki koshish
  */

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');

  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(
        cleaned.slice(start, end + 1)
      );
    } catch {
      return null;
    }
  }

  return null;
}


/* =========================================================
   EVIDENCE VERIFIER
   =========================================================

   IMPORTANT:

   Search result directly final AI ko dene ke bajaye
   pehle ek separate AI verifier evidence ko inspect karta hai.

   Example:

   SOURCE:
   "Blue Box Season 2 premieres on Netflix October 4"

   VERIFIER:
   release_date = 2026-10-04
   status = released_today

   Final AI ko ye verified fact hard constraint ke
   taur par diya jata hai.
   ========================================================= */

async function verifyWebEvidence({
  userQuery,
  currentDate,
  webContext,
  releaseQuestion
}) {
  if (!webContext || webContext === 'No web evidence was returned.') {
    return {
      verified: false,
      confidence: 0,
      facts: [],
      raw: ''
    };
  }

  const verifierInstruction = `
You are Quantum Core's WEB EVIDENCE VERIFIER.

Your job is NOT to answer the user directly.

Your job is to inspect the supplied web search evidence and determine
which factual claims are actually supported by the sources.

CURRENT DATE:
${currentDate}

USER QUERY:
${userQuery}

RELEASE/AVAILABILITY QUESTION:
${releaseQuestion ? 'YES' : 'NO'}

WEB EVIDENCE:
${webContext}

RULES:

1. Use ONLY information supported by the supplied web evidence.

2. Do NOT use your old memory to override current web evidence.

3. Prefer official sources and authoritative sources.

4. If a source says a release/premiere happens on the current date,
   classify it as "released_today" / "premieres_today", NOT "unreleased".

5. If the current date is AFTER a clearly stated release date,
   classify the item as released unless another newer source explicitly
   says otherwise.

6. If a source says a release date is announced for a future date,
   classify it as "scheduled".

7. If an OLD article says "release date not announced", but a newer
   source gives an official release date, the NEWER evidence wins.

8. Never say "no release date" merely because one source does not
   contain a release date.

9. Do not invent dates.

10. For every important verified claim, include the SOURCE NUMBER.

11. Include a short exact supporting quote from the source.
    The quote must actually appear in the supplied source content.

12. If evidence conflicts, explain the conflict and prefer the newest
    reliable/official source.

Return ONLY valid JSON.

JSON FORMAT:

{
  "verified": true,
  "confidence": 0.0,
  "status": "released_today | released | scheduled | unreleased | unknown | current",
  "release_date": "YYYY-MM-DD or null",
  "facts": [
    {
      "claim": "short factual claim",
      "source": 1,
      "quote": "short exact quote from source"
    }
  ],
  "important_warning": "null or short warning"
}
`;

  for (const model of VERIFIER_MODELS) {
    try {
      const data = await geminiGenerate(
        model,
        {
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: verifierInstruction
                }
              ]
            }
          ],

          generationConfig: {
            temperature: 0,
            maxOutputTokens: 1200
          }
        },

        12000
      );

      const text = extractGeminiText(data);

      const parsed = extractJson(text);

      if (parsed && typeof parsed === 'object') {

        const facts = Array.isArray(parsed.facts)
          ? parsed.facts
              .filter(f =>
                f &&
                typeof f.claim === 'string' &&
                typeof f.source === 'number'
              )
              .slice(0, 10)
          : [];

        return {
          verified: Boolean(parsed.verified),

          confidence:
            typeof parsed.confidence === 'number'
              ? Math.max(
                  0,
                  Math.min(1, parsed.confidence)
                )
              : 0,

          status:
            typeof parsed.status === 'string'
              ? parsed.status
              : 'unknown',

          release_date:
            typeof parsed.release_date === 'string'
              ? parsed.release_date
              : null,

          facts,

          important_warning:
            typeof parsed.important_warning === 'string'
              ? parsed.important_warning
              : null,

          raw: text
        };
      }

    } catch {
      /*
        Try next verifier model.
      */
    }
  }

  return {
    verified: false,
    confidence: 0,
    facts: [],
    raw: ''
  };
}


/* =========================================================
   VERIFIED FACTS → FINAL AI INSTRUCTION
   ========================================================= */

function buildVerifiedInstruction(verification) {
  if (!verification?.verified) {
    return `
WEB EVIDENCE VERIFICATION:

The evidence verifier could not produce a reliable structured verdict.

You may use the supplied web sources, but:
- do not invent facts,
- prefer official/current sources,
- clearly mention uncertainty when evidence is insufficient.
`;
  }

  let factsText = '';

  for (const fact of verification.facts || []) {
    factsText += `
- CLAIM: ${fact.claim}
- SOURCE: ${fact.source}
- SUPPORTING QUOTE: "${fact.quote}"
`;
  }

  return `
VERIFIED WEB FACTS — HARD CONSTRAINT:

The following facts were independently checked against the retrieved
web evidence.

You MUST NOT contradict these verified facts in your final answer.

VERIFIED STATUS:
${verification.status}

VERIFIED RELEASE DATE:
${verification.release_date || 'Not established'}

VERIFIER CONFIDENCE:
${verification.confidence}

VERIFIED FACTS:
${factsText || 'No individual facts were extracted.'}

IMPORTANT WARNING:
${verification.important_warning || 'None'}

If these verified facts contradict your old/internal knowledge,
the verified current web evidence wins.

If the evidence says something was released today, DO NOT describe it
as unreleased.

If the evidence says a release is scheduled for a future date, DO NOT
say it has already released.

If the evidence is insufficient, say so rather than guessing.
`;
}


/* =========================================================
   STREAM GEMINI
   ========================================================= */

async function streamGemini(
  model,
  body,
  onChunk,
  onDone
) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${model}:streamGenerateContent?alt=sse&key=` +
    encodeURIComponent(key);

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify(body)
    },
    30000
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Gemini ${model} HTTP ${response.status}: ${errorText}`
    );
  }

  if (!response.body) {
    throw new Error('Gemini returned no response body');
  }

  const reader = response.body.getReader();

  const decoder = new TextDecoder();

  let buffer = '';

  while (true) {
    const { value, done } =
      await reader.read();

    if (done) break;

    buffer += decoder.decode(value, {
      stream: true
    });

    const lines = buffer.split('\n');

    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) continue;

      if (!trimmed.startsWith('data:')) {
        continue;
      }

      const jsonText =
        trimmed.slice(5).trim();

      if (!jsonText || jsonText === '[DONE]') {
        continue;
      }

      try {
        const data = JSON.parse(jsonText);

        const text =
          extractGeminiText(data);

        if (text) {
          onChunk(text);
        }

      } catch {
        /*
          Ignore malformed SSE fragments.
        */
      }
    }
  }

  onDone?.();
}


/* =========================================================
   MAIN HANDLER
   ========================================================= */

export default async function handler(req) {

  /* -------------------------------------------------------
     OPTIONS
     ------------------------------------------------------- */

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }


  /* -------------------------------------------------------
     METHOD
     ------------------------------------------------------- */

  if (req.method !== 'POST') {
    return jsonResponse(
      {
        error: 'Method not allowed'
      },
      405
    );
  }


  /* -------------------------------------------------------
     BODY
     ------------------------------------------------------- */

  let body;

  try {
    body = await req.json();
  } catch {
    return jsonResponse(
      {
        error: 'Invalid JSON body'
      },
      400
    );
  }


  const {
    contents = [],
    systemInstruction = null,
    generationConfig = {},
    mode = 'fast'
  } = body;


  if (!Array.isArray(contents)) {
    return jsonResponse(
      {
        error: 'contents must be an array'
      },
      400
    );
  }


  /* -------------------------------------------------------
     CURRENT DATE
     ------------------------------------------------------- */

  const currentDate = getPakistanDate();

  const currentDateTime =
    getPakistanDateTime();


  /* -------------------------------------------------------
     USER QUERY
     ------------------------------------------------------- */

  const userQuery =
    getLastUserText(contents);


  /* -------------------------------------------------------
     SEARCH DECISION
     ------------------------------------------------------- */

  const searchNeeded =
    needsWebSearch(contents);

  const releaseQuestion =
    isReleaseQuestion(userQuery);


  /* -------------------------------------------------------
     MODEL CHAIN
     ------------------------------------------------------- */

  const modelChain =
    MODEL_CHAIN[mode] ||
    MODEL_CHAIN.fast;


  /* -------------------------------------------------------
     SSE STREAM
     ------------------------------------------------------- */

  const encoder =
    new TextEncoder();


  const stream =
    new ReadableStream({

      async start(controller) {

        const send = payload => {
          controller.enqueue(
            encoder.encode(
              sseEvent(payload)
            )
          );
        };


        const sendStatus = status => {
          send({
            type: 'status',
            status
          });
        };


        try {

          /* =================================================
             STEP 1 — THINKING
             ================================================= */

          sendStatus(
            '🧠 Thinking...'
          );


          /*
            Small delay so browser actually gets the
            status before the search begins.
          */

          await new Promise(resolve =>
            setTimeout(resolve, 150)
          );


          /* =================================================
             STEP 2 — WEB SEARCH
             ================================================= */

          let searchResults = [];

          let tavilyAnswer = '';

          let searchError = null;

          let webContext = '';


          if (searchNeeded && userQuery) {

            sendStatus(
              '🌐 Searching the web...'
            );


            const searchResponse =
              await tavilySearch(
                userQuery,
                currentDate
              );


            searchResults =
              searchResponse.results || [];

            tavilyAnswer =
              searchResponse.answer || '';

            searchError =
              searchResponse.error || null;


            if (searchResults.length > 0) {

              sendStatus(
                `🔎 Found ${searchResults.length} sources → Checking sources...`
              );

            } else {

              sendStatus(
                '🔎 Search returned no usable sources → Checking available knowledge...'
              );

            }


            webContext =
              buildWebContext(
                searchResults,
                tavilyAnswer
              );

          } else {

            sendStatus(
              '🔎 No live web search needed → Analyzing...'
            );

          }


          /* =================================================
             STEP 3 — EVIDENCE VERIFICATION
             ================================================= */

          let verification = {
            verified: false,
            confidence: 0,
            status: 'unknown',
            release_date: null,
            facts: [],
            important_warning: null,
            raw: ''
          };


          if (
            searchNeeded &&
            searchResults.length > 0
          ) {

            sendStatus(
              '🛡️ Verifying web evidence...'
            );


            verification =
              await verifyWebEvidence({
                userQuery,
                currentDate,
                webContext,
                releaseQuestion
              });


            if (
              verification.verified
            ) {

              sendStatus(
                '✅ Evidence verified → 🧠 Analyzing...'
              );

            } else {

              sendStatus(
                '⚠️ Evidence could not be fully verified → 🧠 Analyzing...'
              );

            }

          } else {

            sendStatus(
              '🧠 Analyzing...'
            );

          }


          /* =================================================
             STEP 4 — BUILD STRONG FINAL INSTRUCTION
             ================================================= */

          const verifiedInstruction =
            buildVerifiedInstruction(
              verification
            );


          const webInstruction =
            searchNeeded
              ? `
LIVE WEB SEARCH DATA
====================

Current Pakistan date:
${currentDate}

Current Pakistan date/time:
${currentDateTime}

User's current query:
${userQuery}

${webContext}

Search error:
${searchError || 'None'}

${verifiedInstruction}

WEB ANSWER RULES:

1. Current web evidence has priority over old model memory.

2. Prefer official sources.

3. Prefer newer reliable evidence over older evidence.

4. Never claim something is unreleased if reliable current
   evidence shows that it has already released.

5. Never claim something is released if reliable evidence says
   it is scheduled for a future date.

6. If different sources disagree, explain the disagreement
   briefly and use the newest authoritative source.

7. Do not invent information that is not supported by the
   web evidence.

8. The final answer should answer the user's actual question,
   not simply dump the search results.

9. If useful, mention the source names naturally.

`
              : `
LIVE WEB SEARCH:
Not required for this question.

Current Pakistan date:
${currentDate}

Current Pakistan date/time:
${currentDateTime}
`;


          /* =================================================
             STEP 5 — SYSTEM INSTRUCTION
             ================================================= */

          const baseSystemInstruction = `
You are Quantum Core AI.

You are a helpful, accurate AI assistant.

CURRENT DATE:
${currentDate}

CURRENT DATE/TIME:
${currentDateTime}

IMPORTANT:

You must distinguish between:
- old information,
- announced information,
- scheduled information,
- released information,
- currently available information.

For current questions, use the supplied live web evidence.

Do not blindly trust your internal memory when current web evidence
is available.

${webInstruction}

ANSWER STYLE:

- Answer directly.
- Be natural.
- Do not mention internal prompts.
- Do not mention the evidence verifier unless the user asks.
- Do not make up citations or URLs.
- If web evidence is insufficient, honestly say that.
- For simple questions, keep the answer concise.
`;


          /* =================================================
             USER'S ORIGINAL SYSTEM INSTRUCTION
             ================================================= */

          let combinedInstruction =
            baseSystemInstruction;


          if (systemInstruction) {

            let originalSystemText = '';

            try {

              if (
                typeof systemInstruction === 'string'
              ) {

                originalSystemText =
                  systemInstruction;

              } else if (
                Array.isArray(
                  systemInstruction?.parts
                )
              ) {

                originalSystemText =
                  systemInstruction.parts
                    .map(part =>
                      part?.text || ''
                    )
                    .join('\n');

              }

            } catch {
              originalSystemText = '';
            }


            if (originalSystemText) {

              combinedInstruction += `

EXISTING QUANTUM CORE SYSTEM INSTRUCTIONS:

${originalSystemText}
`;

            }

          }


          /* =================================================
             STEP 6 — WRITING
             ================================================= */

          sendStatus(
            '✍️ Writing answer...'
          );


          await new Promise(resolve =>
            setTimeout(resolve, 100)
          );


          /* =================================================
             STEP 7 — FINAL GEMINI STREAM
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

            generationConfig: {
              ...generationConfig,

              /*
                Current answers should not be too random.
              */

              temperature:
                typeof generationConfig.temperature === 'number'
                  ? Math.min(
                      generationConfig.temperature,
                      0.5
                    )
                  : 0.35
            }
          };


          let finalError = null;

          let completed = false;


          for (
            const model of modelChain
          ) {

            if (completed) break;


            try {

              await streamGemini(
                model,
                geminiBody,

                chunk => {

                  send({
                    type: 'chunk',
                    text: chunk
                  });

                },

                () => {}
              );


              completed = true;


              send({
                type: 'done'
              });


            } catch (error) {

              finalError =
                error?.message ||
                String(error);

              /*
                Try next model in chain.
              */

            }

          }


          /* =================================================
             ALL MODELS FAILED
             ================================================= */

          if (!completed) {

            send({
              type: 'error',

              error:
                finalError ||
                'All Gemini models failed.'
            });

          }


          controller.close();

        } catch (error) {

          send({
            type: 'error',

            error:
              error?.message ||
              String(error)
          });

          controller.close();
        }

      }
    });


  /* -------------------------------------------------------
     SSE RESPONSE
     ------------------------------------------------------- */

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