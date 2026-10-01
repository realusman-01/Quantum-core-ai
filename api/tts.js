import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60
};

const VOICE_MAP = {
  male:   { en: 'en-US-GuyNeural',   ur: 'ur-PK-AsadNeural',   hi: 'hi-IN-MadhurNeural' },
  female: { en: 'en-US-AriaNeural',  ur: 'ur-PK-UzmaNeural',   hi: 'hi-IN-SwaraNeural' }
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

  const { text, gender, lang } = body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });

  const safeGender = (gender === 'female') ? 'female' : 'male';
  const safeLang = (lang === 'ur' || lang === 'hi') ? lang : 'en';
  const voiceName = VOICE_MAP[safeGender][safeLang];

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    
    const { audioStream } = await tts.toStream(text.trim());
    
    const chunks = [];
    await new Promise((resolve, reject) => {
      audioStream.on('data', (chunk) => chunks.push(chunk));
      audioStream.on('end', resolve);
      audioStream.on('error', reject);
    });

    const audioBuffer = Buffer.concat(chunks);
    
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    return res.status(200).send(audioBuffer);
  } catch (err) {
    console.error('Edge TTS error:', err);
    return res.status(502).json({ error: 'TTS failed', details: err.message });
  }
}
