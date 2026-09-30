export const config = {
  runtime: 'nodejs',
  maxDuration: 60
};

const CF_MODEL = '@cf/black-forest-labs/flux-1-schnell';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId) return res.status(500).json({ error: 'CLOUDFLARE_ACCOUNT_ID not configured' });
  if (!apiToken) return res.status(500).json({ error: 'CLOUDFLARE_API_TOKEN not configured' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

  const { prompt } = body;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CF_MODEL}`;

  try {
    console.log('Image gen:', prompt.substring(0, 100));

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

    if (!cfRes.ok) {
      let errDetails = 'Unknown';
      try { errDetails = (await cfRes.text()).substring(0, 500); } catch(e){}
      console.error('CF error:', cfRes.status, errDetails);

      let friendly = 'Image generation failed';
      if (cfRes.status === 401 || cfRes.status === 403) friendly = 'Cloudflare authentication failed. Check API token.';
      else if (cfRes.status === 429) friendly = 'Rate limit reached. Try again shortly.';
      else if (cfRes.status === 404) friendly = 'Model not found.';
      else if (cfRes.status === 400) friendly = 'Invalid request.';

      return res.status(cfRes.status).json({ error: friendly, details: errDetails });
    }

    const contentType = (cfRes.headers.get('content-type') || '').toLowerCase();
    console.log('CF Response Content-Type:', contentType);

    let base64Image = null;
    let mimeType = 'image/png';

    if (contentType.includes('application/json')) {
      // JSON response: { result: { image: "base64..." } }
      const data = await cfRes.json();
      console.log('CF JSON keys:', Object.keys(data));
      
      // Different possible paths
      if (data.result && data.result.image) {
        base64Image = data.result.image;
      } else if (data.image) {
        base64Image = data.image;
      } else if (data.result && typeof data.result === 'string') {
        base64Image = data.result;
      }
      
      if (base64Image) {
        // Detect MIME from base64 prefix
        if (base64Image.startsWith('/9j/')) mimeType = 'image/jpeg';
        else if (base64Image.startsWith('iVBOR')) mimeType = 'image/png';
      }
    } else {
      // Raw binary response
      const arrayBuffer = await cfRes.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      console.log('CF binary size:', bytes.length, 'first bytes:', bytes[0], bytes[1], bytes[2], bytes[3]);
      
      // Detect MIME from magic bytes
      if (bytes[0] === 0x89 && bytes[1] === 0x50) mimeType = 'image/png'; // PNG
      else if (bytes[0] === 0xFF && bytes[1] === 0xD8) mimeType = 'image/jpeg'; // JPEG
      
      base64Image = Buffer.from(arrayBuffer).toString('base64');
    }

    if (!base64Image) {
      console.error('No image found in response');
      return res.status(500).json({ error: 'No image in Cloudflare response' });
    }

    const dataUri = `data:${mimeType};base64,${base64Image}`;
    console.log('✅ Image ready. MIME:', mimeType, 'Length:', dataUri.length);

    return res.status(200).json({
      imageUrl: dataUri,
      model: CF_MODEL,
      mime: mimeType
    });

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(502).json({ error: err.message });
  }
}
