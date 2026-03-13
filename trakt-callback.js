export default async function handler(req, res) {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'Missing code' });
  }

  try {
    const response = await fetch('https://api.trakt.tv/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id:     process.env.TRAKT_CLIENT_ID,
        client_secret: process.env.TRAKT_CLIENT_SECRET,
        redirect_uri:  process.env.TRAKT_REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(400).json({ error: 'Token exchange failed', detail: err });
    }

    const tokens = await response.json();

    // Redirect back to the app with the token in the URL fragment
    // (fragment never reaches the server, stays client-side only)
    const appUrl = new URL(process.env.APP_URL || 'https://cineai-pwa.vercel.app');
    appUrl.hash = `trakt_token=${tokens.access_token}&trakt_refresh=${tokens.refresh_token}&trakt_expires=${tokens.expires_in}`;

    res.redirect(appUrl.toString());
  } catch (e) {
    res.status(500).json({ error: 'Internal error', detail: e.message });
  }
}
