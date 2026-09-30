export const config = {
  runtime: 'nodejs',
  maxDuration: 60
};

// Cloudflare Workers AI Model
// Flux-1-Schnell = fast, high-quality, free tier
const CF_MODEL = '@cf/black-forest-labs/flux-1-schnell';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Read Cloudflare credentials from Vercel Environment Variables
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId) {
    return res.status(500).json({ 
      error: 'CLOUDFLARE_ACCOUNT_ID not configured in Vercel Environment Variables' 
    });
  }

  if (!apiToken) {
    return res.status(500).json({ 
      error: 'CLOUDFLARE_API_TOKEN not configured in Vercel Environment Variables' 
    });
  }

  // Parse request body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { prompt } = body;

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  // Cloudflare Workers AI endpoint
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CF_MODEL}`;

  try {
    console.log('Cloudflare Image Gen - Prompt:', prompt.substring(0, 100));

    const cfRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: prompt.trim(),
        steps: 4
      })
    });

    // Handle errors from Cloudflare
    if (!cfRes.ok) {
      let errDetails = 'Unknown error';
      try {
        const errText = await cfRes.text();
        errDetails = errText.substring(0, 500);
        console.error('Cloudflare AI error:', cfRes.status, errDetails);
      } catch (e) {
        console.error('Could not read Cloudflare error');
      }

      let friendlyError = 'Image generation failed';
      if (cfRes.status === 401 || cfRes.status === 403) {
        friendlyError = 'Cloudflare authentication failed. Check API token.';
      } else if (cfRes.status === 429) {
        friendlyError = 'Cloudflare rate limit reached. Please try again in a moment.';
      } else if (cfRes.status === 404) {
        friendlyError = 'Model not found. Check Workers AI access.';
      } else if (cfRes.status === 400) {
        friendlyError = 'Invalid prompt or request format.';
      }

      return res.status(cfRes.status).json({
        error: friendlyError,
        status: cfRes.status,
        details: errDetails
      });
    }

    // Cloudflare returns raw PNG bytes
    const arrayBuffer = await cfRes.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    const dataUri = `data:image/png;base64,${base64}`;

    console.log('✅ Image generated successfully. Size:', arrayBuffer.byteLength, 'bytes');

    return res.status(200).json({
      imageUrl: dataUri,
      model: 'flux-1-schnell',
      size: arrayBuffer.byteLength
    });

  } catch (err) {
    console.error('Image proxy error:', err);
    return res.status(502).json({
      error: 'Image generation failed',
      details: err.message
    });
  }
}
