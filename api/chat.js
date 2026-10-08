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
    'gemini-3.1-flash-lite'
  ]
};

const SEARCH_DECISION_MODEL = 'gemini-3.5-flash-lite';

const GEMINI_API =
  'https://generativelanguage.googleapis.com/v1beta/models/';

const TAVILY_API =
  'https://api.tavily.com/search';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};


// ============================================================
// BASIC RESPONSE
// ============================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json'
    }
  });
}


// ============================================================
// TIMEOUT FETCH
// ============================================================

async function fetchWithTimeout(
  url,
  options = {},
  timeout = 10000
) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);

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
// EXTRACT TEXT FROM FRONTEND CONTENTS
// ============================================================

function getLatestUserText(contents) {
  if (!Array.isArray(contents)) {
    return '';
  }

  for (let i = contents.length - 1; i >= 0; i--) {
    const message = contents[i];

    if (
      message &&
      message.role === 'user' &&
      Array.isArray(message.parts)
    ) {
      const text = message.parts
        .map(part => {
          if (typeof part?.text === 'string') {
            return part.text;
          }

          return '';
        })
        .join(' ')
        .trim();

      if (text) {
        return text;
      }
    }
  }

  return '';
}


// ============================================================
// MEMORY
// ============================================================

async function fetchMemories(userId, userText) {
  if (!userId || !process.env.SUPABASE_URL) {
    return [];
  }

  try {
    const url =
      `${process.env.SUPABASE_URL}/rest/v1/memories` +
      `?user_id=eq.${encodeURIComponent(userId)}` +
      `&select=*` +
      `&limit=50`;

    const response = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: {
          apikey: process.env.SUPABASE_SECRET_KEY,
          Authorization:
            `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        }
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

    const text =
      String(userText || '').toLowerCase();

    const words = text
      .split(/\s+/)
      .filter(word => word.length >= 4);

    const scored = memories.map(memory => {
      const searchable = [
        memory.key,
        memory.value,
        memory.category,
        memory.content,
        memory.type
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      let score = 0;

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
      'Memory error:',
      error?.message || error
    );

    return [];
  }
}


function buildMemoryContext(memories) {
  if (!memories.length) {
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
Do not invent memories.
`;
}


// ============================================================
// SEARCH DETECTION
// ============================================================

function looksLikeFreshInfoQuestion(text) {
  const t =
    String(text || '').toLowerCase();

  const patterns = [
    'latest',
    'today',
    "today's",
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
    'scores',
    'result',
    'results',
    'release date',
    'released',
    'available now',
    'who won',
    'current president',
    'current prime minister'
  ];

  return patterns.some(
    pattern => t.includes(pattern)
  );
}


function definitelyDoesNotNeedSearch(text) {
  const t =
    String(text || '').trim().toLowerCase();

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
    'translate',
    'rewrite',
    'rephrase',
    'proofread',
    'debug this code',
    'explain this code'
  ];

  return patterns.some(
    pattern =>
      t.startsWith(pattern) ||
      t.includes(pattern)
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

  if (Array.isArray(data.candidates)) {
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
  if (!userText) {
    return false;
  }

  if (looksLikeFreshInfoQuestion(userText)) {
    return true;
  }

  if (definitelyDoesNotNeedSearch(userText)) {
    return false;
  }

  const apiKey =
    process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return false;
  }

  try {
    const url =
      `${GEMINI_API}${SEARCH_DECISION_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response =
      await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json'
          },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: `
Decide whether this user question requires
a live web search.

Return ONLY:
YES
or
NO

Use YES when the answer depends on
current, recent, changing, real-world,
or time-sensitive information.

Question:
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

    const data =
      await response.json();

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
// TAVILY
// ============================================================

async function tavilySearch(query) {
  const apiKey =
    process.env.TAVILY_API_KEY;

  if (!apiKey || !query) {
    return [];
  }

  try {
    const response =
      await fetchWithTimeout(
        TAVILY_API,
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json'
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
        'Tavily HTTP:',
        response.status
      );

      return [];
    }

    const data =
      await response.json();

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
  if (!results.length) {
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

Use the web results when relevant.
Do not invent facts that are contradicted
by the search results.
`;
}


// ============================================================
// MERMAID SAFETY
// ============================================================

const diagramInstruction = `

DIAGRAM SAFETY:

When creating Mermaid diagrams:

- Use valid Mermaid syntax.
- Keep node IDs simple.
- Never use raw coordinate pairs as node IDs.
- Never place stray characters after nodes.
- Never mix normal text into Mermaid code fences.
- Close every Mermaid code fence.

For mathematical diagrams, prefer safe syntax such as:

flowchart LR
    A["Point A"]
    B["Point B"]
    A --> B

Do not generate a Mermaid diagram unless useful.
`;


// ============================================================
// CUSTOM SSE HELPERS
// ============================================================

function sseEvent(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}


// ============================================================
// GEMINI STREAM -> QUANTUM CORE STREAM
// ============================================================

async function streamGeminiToClient(
  geminiResponse
) {
  const source =
    geminiResponse.body;

  if (!source) {
    throw new Error(
      'Gemini returned no stream body'
    );
  }

  const reader =
    source.getReader();

  const decoder =
    new TextDecoder();

  const encoder =
    new TextEncoder();

  let buffer = '';

  const stream =
    new ReadableStream({
      async start(controller) {

        try {

          // Initial status
          controller.enqueue(
            encoder.encode(
              sseEvent({
                type: 'status',
                status: 'Thinking...'
              })
            )
          );

          while (true) {

            const result =
              await reader.read();

            if (result.done) {
              break;
            }

            buffer += decoder.decode(
              result.value,
              {
                stream: true
              }
            );

            const lines =
              buffer.split('\n');

            buffer =
              lines.pop() || '';

            for (
              const line of lines
            ) {

              const trimmed =
                line.trim();

              if (
                !trimmed.startsWith(
                  'data:'
                )
              ) {
                continue;
              }

              const raw =
                trimmed
                  .substring(5)
                  .trim();

              if (
                !raw ||
                raw === '[DONE]'
              ) {
                continue;
              }

              let parsed;

              try {
                parsed =
                  JSON.parse(raw);
              } catch {
                continue;
              }

              const text =
                extractModelText(
                  parsed
                );

              if (!text) {
                continue;
              }

              controller.enqueue(
                encoder.encode(
                  sseEvent({
                    type: 'chunk',
                    text
                  })
                )
              );
            }
          }

          controller.enqueue(
            encoder.encode(
              sseEvent({
                type: 'done'
              })
            )
          );

          controller.close();

        } catch (error) {

          console.error(
            'Stream conversion error:',
            error?.message || error
          );

          controller.enqueue(
            encoder.encode(
              sseEvent({
                type: 'error',
                error:
                  error?.message ||
                  'Streaming error'
              })
            )
          );

          controller.close();

        } finally {
          try {
            reader.releaseLock();
          } catch {}
        }
      }
    });

  return stream;
}


// ============================================================
// GEMINI REQUEST
// ============================================================

async function createGeminiResponse({
  model,
  contents,
  systemInstruction,
  generationConfig
}) {
  const apiKey =
    process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is missing'
    );
  }

  const url =
    `${GEMINI_API}${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const controller =
    new AbortController();

  // Only connection timeout.
  // Once Gemini starts responding,
  // the stream is NOT aborted.
  const timer =
    setTimeout(
      () => controller.abort(),
      15000
    );

  let response;

  try {

    response =
      await fetch(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json'
          },
          body: JSON.stringify({
            contents,
            systemInstruction: {
              parts: [
                {
                  text:
                    systemInstruction
                }
              ]
            },
            generationConfig
          }),
          signal: controller.signal
        }
      );

  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {

    const errorText =
      await response
        .text()
        .catch(() => '');

    throw new Error(
      `Gemini ${model} HTTP ${response.status}: ${errorText.substring(0, 300)}`
    );
  }

  return response;
}


// ============================================================
// MAIN HANDLER
// ============================================================

export default async function handler(req) {

  // OPTIONS
  if (req.method === 'OPTIONS') {
    return new Response(
      null,
      {
        status: 204,
        headers: CORS_HEADERS
      }
    );
  }

  // POST ONLY
  if (req.method !== 'POST') {
    return json(
      {
        error:
          'Method not allowed'
      },
      405
    );
  }

  // ----------------------------------------------------------
  // READ FRONTEND BODY
  // ----------------------------------------------------------

  let body;

  try {
    body = await req.json();
  } catch (error) {

    return json(
      {
        error:
          'Invalid request body'
      },
      400
    );
  }

  // THIS MATCHES YOUR FRONTEND EXACTLY
  const contents =
    Array.isArray(body?.contents)
      ? body.contents
      : [];

  const userId =
    body?.userId || '';

  const conversationId =
    body?.conversationId || '';

  const activeMode =
    body?.mode || 'core';

  const generationConfig =
    body?.generationConfig &&
    typeof body.generationConfig === 'object'
      ? body.generationConfig
      : {
          temperature: 0.7
        };


  // ----------------------------------------------------------
  // VALIDATION
  // ----------------------------------------------------------

  if (!contents.length) {

    return json(
      {
        error:
          'Invalid request: contents missing'
      },
      400
    );
  }

  const userText =
    getLatestUserText(contents);

  if (!userText) {

    return json(
      {
        error:
          'Invalid request: user message missing'
      },
      400
    );
  }


  // ----------------------------------------------------------
  // MEMORY + SEARCH DECISION
  // ----------------------------------------------------------

  const memoryPromise =
    fetchMemories(
      userId,
      userText
    );

  const searchPromise =
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
      searchPromise
    ]);

  } catch (error) {

    console.error(
      'Preparation error:',
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
  // SYSTEM INSTRUCTION
  // ----------------------------------------------------------

  const clientInstruction =
    body?.systemInstruction?.parts?.[0]?.text ||
    '';

  const memoryContext =
    buildMemoryContext(
      memories
    );

  const searchContext =
    buildSearchContext(
      searchResults
    );

  const finalSystemInstruction = `

${clientInstruction}

CURRENT DATE:
October 8, 2026.

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
`;


  // ----------------------------------------------------------
  // MODEL CHAIN
  // ----------------------------------------------------------

  const chain =
    activeMode === 'fast'
      ? MODEL_CHAIN.fast
      : MODEL_CHAIN.core;


  let lastError = null;


  // ----------------------------------------------------------
  // TRY MODELS
  // ----------------------------------------------------------

  for (const model of chain) {

    try {

      const geminiResponse =
        await createGeminiResponse({
          model,
          contents,
          systemInstruction:
            finalSystemInstruction,
          generationConfig
        });


      // Convert Gemini SSE into
      // the format your frontend expects.
      const stream =
        await streamGeminiToClient(
          geminiResponse
        );


      return new Response(
        stream,
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
        `Model ${model} failed:`,
        error?.message || error
      );

      // Try fallback model
    }
  }


  // ----------------------------------------------------------
  // EVERYTHING FAILED
  // ----------------------------------------------------------

  return json(
    {
      error:
        'All Gemini models failed',
      details:
        lastError?.message ||
        'Unknown server error'
    },
    500
  );
}