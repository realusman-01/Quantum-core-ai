export const config = {
  runtime: 'nodejs',
  maxDuration: 30
};

const MODEL_CHAIN = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { prompt } = body;
  if (!prompt) {
    return res.status(400).json({ error: 'prompt required' });
  }

  const geminiBody = {
    contents: [
      {
        parts: [
          {
            text: 'Summarize this into a short 2-5 word chat title without punctuation: ' + prompt
          }
        ]
      }
    ]
  };

  let lastError = null;

  // Har model ko ek-ek karke try karo
  for (const modelName of MODEL_CHAIN) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;
      
      console.log(`Title: Trying model: ${modelName}`);
      
      const geminiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody)
      });

      if (geminiRes.ok) {
        console.log(`Title: ✅ Success with model: ${modelName}`);
        const data = await geminiRes.text();
        return res.status(200).send(data);
      } else {
        console.warn(`Title: ⚠️ Model ${modelName} failed with status ${geminiRes.status}`);
        lastError = new Error(`Model ${modelName} failed: ${geminiRes.status}`);
      }
    } catch (err) {
      console.error(`Title: ❌ Model ${modelName} threw error:`, err.message);
      lastError = err;
    }
  }

  // Agar saare models fail ho jayein
  console.error('Title: All models failed.');
  return res.status(502).json({
    error: 'Title generation failed',
    details: lastError ? lastError.message : 'Unknown error'
  });
}
