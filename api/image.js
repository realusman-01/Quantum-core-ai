export const config = {
  runtime: 'nodejs',
  maxDuration: 60
};

// Model fallback chain for image generation
const IMAGE_MODEL_CHAIN = [
  'gemini-3.1-flash-image',
  'gemini-2.5-flash-image',
  'gemini-3-pro-image'
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { prompt } = body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  let lastError = 'Unknown';

  for (const modelName of IMAGE_MODEL_CHAIN) {
    try {
      console.log('Image gen trying model:', modelName);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const geminiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: 'Generate an image of: ' + prompt }]
          }],
          generationConfig: {
            responseModalities: ['IMAGE', 'TEXT']
          }
        })
      });

      const rawText = await geminiRes.text();

      if (!geminiRes.ok) {
        console.warn(`Model ${modelName} failed: ${geminiRes.status}`, rawText.substring(0, 200));
        lastError = `Model ${modelName}: ${geminiRes.status}`;
        continue; // Try next model
      }

      let data;
      try { data = JSON.parse(rawText); }
      catch (e) { lastError = 'JSON parse failed'; continue; }

      // Extract image from response
      let imageData = null;
      let mimeType = 'image/png';

      const candidates = data.candidates || [];
      for (const c of candidates) {
        const parts = c.content?.parts || [];
        for (const p of parts) {
          if (p.inlineData && p.inlineData.data) {
            imageData = p.inlineData.data;
            mimeType = p.inlineData.mimeType || 'image/png';
            break;
          }
        }
        if (imageData) break;
      }

      if (!imageData) {
        console.warn(`Model ${modelName} returned no image. Raw:`, rawText.substring(0, 400));
        lastError = `Model ${modelName}: no image in response`;
        continue;
      }

      console.log('✅ Image generated with:', modelName);
      return res.status(200).json({
        imageUrl: `data:${mimeType};base64,${imageData}`,
        model: modelName
      });

    } catch (err) {
      console.error(`Model ${modelName} error:`, err.message);
      lastError = err.message;
    }
  }

  return res.status(502).json({
    error: 'All image models failed',
    details: lastError
  });
}
