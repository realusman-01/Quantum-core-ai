export const runtime = "edge";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DREAM_SECRET = process.env.DREAM_SECRET;
const CRON_SECRET = process.env.CRON_SECRET;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

async function supabase(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${
        typeof data === "string" ? data : JSON.stringify(data)
      }`
    );
  }

  return data;
}

async function gemini(prompt) {
  const models = [
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite",
  ];

  let lastError = null;

  for (const model of models) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
          GEMINI_API_KEY
        )}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [{ text: prompt }],
              },
            ],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: "application/json",
            },
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        lastError = new Error(
          `Gemini ${response.status}: ${JSON.stringify(data)}`
        );
        continue;
      }

      const text =
        data?.candidates?.[0]?.content?.parts
          ?.map((p) => p.text || "")
          .join("") || "";

      if (!text) {
        lastError = new Error("Gemini returned an empty response.");
        continue;
      }

      return text;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Gemini request failed.");
}

function clamp(value, min, max) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.max(min, Math.min(max, number));
}

function cleanText(value, maxLength = 1000) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function parseGeminiJSON(text) {
  let cleaned = text.trim();

  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }

    throw new Error("Gemini returned invalid JSON.");
  }
}

function verifyEnvironment() {
  const missing = [];

  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SUPABASE_SECRET_KEY) missing.push("SUPABASE_SECRET_KEY");
  if (!GEMINI_API_KEY) missing.push("GEMINI_API_KEY");

  if (!DREAM_SECRET && !CRON_SECRET) {
    missing.push("DREAM_SECRET or CRON_SECRET");
  }

  return missing;
}

export default async function handler(req) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      return json(
        {
          ok: false,
          error: "Method not allowed.",
        },
        405
      );
    }

    const missing = verifyEnvironment();

    if (missing.length) {
      return json(
        {
          ok: false,
          error: "Missing environment variables.",
          missing,
        },
        500
      );
    }

    // -----------------------------------------
    // Protect the Dreaming endpoint
    //
    // Vercel Cron:
    // Authorization: Bearer <CRON_SECRET>
    //
    // DREAM_SECRET is also accepted for
    // backward compatibility with manual calls.
    // -----------------------------------------

    const authorization = req.headers.get("authorization") || "";

    const validDreamSecret =
      DREAM_SECRET && authorization === `Bearer ${DREAM_SECRET}`;

    const validCronSecret =
      CRON_SECRET && authorization === `Bearer ${CRON_SECRET}`;

    if (!validDreamSecret && !validCronSecret) {
      return json(
        {
          ok: false,
          error: "Unauthorized.",
        },
        401
      );
    }

    // -----------------------------------------
    // Find one pending Dream Job
    // -----------------------------------------

    const jobs = await supabase(
      "dream_jobs?status=eq.pending&order=created_at.asc&limit=1&select=*"
    );

    if (!jobs || jobs.length === 0) {
      return json({
        ok: true,
        status: "idle",
        message: "No pending Dreaming jobs.",
      });
    }

    const job = jobs[0];

    // Mark job as processing
    await supabase(`dream_jobs?id=eq.${job.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "processing",
        started_at: new Date().toISOString(),
      }),
    });

    try {
      // -----------------------------------------
      // Get unprocessed conversation events
      // -----------------------------------------

      const events = await supabase(
        `conversation_events?user_id=eq.${encodeURIComponent(
          job.user_id
        )}&processed_at=is.null&order=created_at.asc&limit=30&select=id,user_id,conversation_id,role,content,created_at`
      );

      if (!events || events.length === 0) {
        await supabase(`dream_jobs?id=eq.${job.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            status: "completed",
            completed_at: new Date().toISOString(),
          }),
        });

        return json({
          ok: true,
          status: "completed",
          message: "No new conversation events to dream about.",
        });
      }

      // -----------------------------------------
      // Get existing memories
      // -----------------------------------------

      const existingMemories = await supabase(
        `memories?user_id=eq.${encodeURIComponent(
          job.user_id
        )}&order=importance.desc,updated_at.desc&limit=100&select=id,user_id,memory_type,memory_key,content,importance,confidence,created_at,updated_at,last_used_at`
      );

      // -----------------------------------------
      // Build safe conversation context
      // -----------------------------------------

      const conversationText = events
        .map((event) => {
          const role = event.role === "user" ? "USER" : "ASSISTANT";

          return `${role}: ${cleanText(event.content, 2500)}`;
        })
        .join("\n\n");

      const memoryText =
        existingMemories && existingMemories.length
          ? existingMemories
              .map(
                (memory) =>
                  `KEY: ${memory.memory_key}\nTYPE: ${memory.memory_type}\nCONTENT: ${memory.content}\nIMPORTANCE: ${memory.importance}\nCONFIDENCE: ${memory.confidence}`
              )
              .join("\n\n---\n\n")
          : "(No existing memories)";

      // -----------------------------------------
      // QUANTUM DREAMING
      // -----------------------------------------

      const prompt = `
You are Quantum Core's Memory Consolidation Engine.

Your job is to analyze recent conversation events and decide
what useful long-term memories should be stored for this user.

IMPORTANT PRIVACY RULES:

- Prefer non-sensitive information.
- Do NOT create memories about health, medical conditions,
  sexuality, religion, political beliefs, passwords, API keys,
  exact location, financial information, or other highly sensitive
  personal information.
- Do NOT infer sensitive information.
- Do NOT store temporary emotional states.
- Do NOT store random one-time questions unless they reveal
  a stable long-term preference or project.
- Only use information actually supported by the conversation.
- Never invent facts.
- User statements have priority over assistant statements.

GOOD MEMORY TYPES:

profile
preference
project
skill
goal
instruction
interest

GOOD EXAMPLES:

"The user prefers explanations in Roman Urdu."
"The user is building Quantum Core AI."
"The user prefers complete single-file HTML solutions."
"The user is interested in anime romcoms."
"The user develops primarily on a mobile phone."

BAD EXAMPLES:

"The user is probably from X."
"The user seems depressed."
"The user might have X medical condition."
"The user's password is X."
"The user is currently at X location."

MEMORY ACTIONS:

ADD
Create a completely new useful memory.

UPDATE
Replace an existing memory when newer user information
clearly changes it.

MERGE
Combine closely related memories without creating duplicates.

INVALIDATE
Mark an existing memory as no longer valid.

IGNORE
Do nothing.

DUPLICATE PREVENTION:

Use a stable memory_key.

Examples:

preference.language
preference.code_style
project.quantum_core
interest.anime
goal.youtube
instruction.response_style

If an existing memory already represents the same fact,
UPDATE or MERGE it instead of ADD.

IMPORTANCE:

0.0 = almost useless
0.5 = moderately useful
0.8 = highly useful
1.0 = extremely important

CONFIDENCE:

0.0 = uncertain
0.5 = somewhat supported
0.8 = strongly supported
1.0 = explicitly stated by user

RECENT CONVERSATION:

${conversationText}

EXISTING MEMORIES:

${memoryText}

Return ONLY valid JSON.

Required format:

{
  "operations": [
    {
      "action": "ADD",
      "memory_key": "preference.language",
      "memory_type": "preference",
      "content": "The user prefers explanations in Roman Urdu.",
      "importance": 0.85,
      "confidence": 0.98
    }
  ]
}

For UPDATE or MERGE, use the existing memory_key.

For INVALIDATE:

{
  "action": "INVALIDATE",
  "memory_key": "some.key",
  "reason": "The user explicitly said this is no longer true."
}

If nothing deserves to be remembered:

{
  "operations": []
}

Maximum 8 operations.
`;

      const aiText = await gemini(prompt);

      const result = parseGeminiJSON(aiText);

      const operations = Array.isArray(result?.operations)
        ? result.operations.slice(0, 8)
        : [];

      const allowedActions = new Set([
        "ADD",
        "UPDATE",
        "MERGE",
        "INVALIDATE",
        "IGNORE",
      ]);

      let added = 0;
      let updated = 0;
      let invalidated = 0;

      // -----------------------------------------
      // Apply Dreaming decisions
      // -----------------------------------------

      for (const operation of operations) {
        const action = String(operation.action || "")
          .trim()
          .toUpperCase();

        if (!allowedActions.has(action)) {
          continue;
        }

        if (action === "IGNORE") {
          continue;
        }

        const memoryKey = cleanText(operation.memory_key, 120);

        if (!memoryKey) {
          continue;
        }

        // INVALIDATE
        if (action === "INVALIDATE") {
          const existing = existingMemories?.find(
            (m) => m.memory_key === memoryKey
          );

          if (existing) {
            await supabase(`memories?id=eq.${existing.id}`, {
              method: "DELETE",
            });

            invalidated++;
          }

          continue;
        }

        const content = cleanText(operation.content, 1000);

        if (!content) {
          continue;
        }

        const memoryType = cleanText(
          operation.memory_type || "profile",
          50
        );

        const importance = clamp(operation.importance, 0.1, 1.0);

        const confidence = clamp(operation.confidence, 0.1, 1.0);

        // Check existing memory with same key
        const existing = existingMemories?.find(
          (m) => m.memory_key === memoryKey
        );

        const now = new Date().toISOString();

        if (existing) {
          // UPDATE / MERGE
          await supabase(`memories?id=eq.${existing.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              memory_type: memoryType,
              content,
              importance,
              confidence,
              updated_at: now,
            }),
          });

          updated++;
        } else {
          // ADD
          await supabase("memories", {
            method: "POST",
            headers: {
              Prefer: "return=minimal",
            },
            body: JSON.stringify({
              user_id: job.user_id,
              memory_type: memoryType,
              memory_key: memoryKey,
              content,
              importance,
              confidence,
              created_at: now,
              updated_at: now,
            }),
          });

          added++;
        }
      }

      // -----------------------------------------
      // Mark events as processed
      // -----------------------------------------

      const eventIds = events.map((event) => event.id);

      if (eventIds.length) {
        await supabase(
          `conversation_events?id=in.(${eventIds.join(",")})`,
          {
            method: "PATCH",
            body: JSON.stringify({
              processed_at: new Date().toISOString(),
            }),
          }
        );
      }

      // -----------------------------------------
      // Complete Dream Job
      // -----------------------------------------

      await supabase(`dream_jobs?id=eq.${job.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "completed",
          completed_at: new Date().toISOString(),
        }),
      });

      return json({
        ok: true,
        status: "completed",
        dream: {
          events_processed: events.length,
          operations: operations.length,
          memories_added: added,
          memories_updated: updated,
          memories_invalidated: invalidated,
        },
      });
    } catch (dreamError) {
      const errorMessage = cleanText(
        dreamError?.message || "Dreaming failed.",
        1000
      );

      await supabase(`dream_jobs?id=eq.${job.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "failed",
          error: errorMessage,
        }),
      });

      throw dreamError;
    }
  } catch (error) {
    return json(
      {
        ok: false,
        error: error?.message || "Dreaming engine failed.",
      },
      500
    );
  }
}