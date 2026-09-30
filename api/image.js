export const config = {
  runtime: 'nodejs',
  maxDuration: 60
};

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

  // Use gemini-3.1-flash-image (Nano Banana 2) for image generation
  const modelName = 'gemini-3.1-flash-image';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }]
      })
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return res.status(geminiRes.status).json({ error: 'Gemini error', details: errText.substring(0, 300) });
    }

    const data = await geminiRes.json();
    
    // Image data kandho response se
    let imageData = null;
    let mimeType = 'image/png';
    
    const candidates = data.candidates || [];
    for (const c of candidates) {
      const parts = c.content?.parts || [];
      for (const p of parts) {
        if (p.inlineData) {
          imageData = p.inlineData.data;
          mimeType = p.inlineData.mimeType || 'image/png';
          break;
        }
      }
      if (imageData) break;
    }

    if (!imageData) {
      return res.status(500).json({ error: 'No image in response', raw: JSON.stringify(data).substring(0, 300) });
    }

    return res.status(200).json({
      imageUrl: `data:${mimeType};base64,${imageData}`
    });

  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
