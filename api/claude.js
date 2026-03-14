export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    // Extract messages and system from Anthropic-style request body
    const { messages, system, max_tokens } = req.body;

    // Build Gemini contents array
    const contents = [];
    if (system) {
      contents.push({ role: 'user', parts: [{ text: `${system}\n\n---` }] });
      contents.push({ role: 'model', parts: [{ text: 'Entendido.' }] });
    }
    for (const msg of messages) {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: {
            maxOutputTokens: max_tokens || 1000,
            temperature: 0.7,
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Gemini error' });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Return in Anthropic-compatible format so the frontend doesn't need to change
    res.status(200).json({
      content: [{ type: 'text', text }]
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
