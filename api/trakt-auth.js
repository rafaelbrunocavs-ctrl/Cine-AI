export default function handler(req, res) {
  const clientId = process.env.TRAKT_CLIENT_ID;
  const redirectUri = process.env.TRAKT_REDIRECT_URI;

  const url = new URL('https://trakt.tv/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);

  res.redirect(url.toString());
}
