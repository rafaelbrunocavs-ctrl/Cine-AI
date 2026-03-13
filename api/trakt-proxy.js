export default async function handler(req, res) {
  // Allow CORS from same origin
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'Missing path' });

  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Missing token' });

  try {
    const traktRes = await fetch(`https://api.trakt.tv/${path}`, {
      headers: {
        'Authorization':      authHeader,
        'trakt-api-version':  '2',
        'trakt-api-key':      process.env.TRAKT_CLIENT_ID,
        'Content-Type':       'application/json',
      },
    });

    const data = await traktRes.json();
    res.status(traktRes.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
