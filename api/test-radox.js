export const config = {
  runtime: 'edge'
};

export default async function handler(req) {
  const key = process.env.RADOX_API_KEY;

  if (!key) {
    return new Response(JSON.stringify({
      error: 'RADOX_API_KEY not configured in Vercel'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Test 1: Fetch models list
    const modelsRes = await fetch('https://radoxai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${key}` }
    });

    const modelsData = await modelsRes.text();

    // Test 2: Try a simple chat completion
    const chatRes = await fetch('https://radoxai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        messages: [
          { role: 'user', content: 'Say "Radox working!" in 3 words only.' }
        ],
        max_tokens: 20
      })
    });

    const chatData = await chatRes.text();

    return new Response(JSON.stringify({
      models_status: modelsRes.status,
      models_response: modelsData.substring(0, 3000),
      chat_status: chatRes.status,
      chat_response: chatData.substring(0, 1500)
    }, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      error: error.message,
      stack: error.stack
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}