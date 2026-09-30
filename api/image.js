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

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { prompt } = body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  try {
    // Pollinations.ai - free, no API key needed
    // Random seed taaki har baar nayi image bane
    const seed = Math.floor(Math.random() * 1000000);
    const encodedPrompt = encodeURIComponent(prompt.trim());
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&seed=${seed}&nologo=true`;

    // Direct URL return karo (frontend khud load kar lega)
    return res.status(200).json({
      imageUrl: imageUrl,
      model: 'pollinations-flux',
      seed: seed
    });

  } catch (err) {
    return res.status(500).json({
      error: 'Image generation failed',
      details: err.message
    });
  }
}
