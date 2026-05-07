const { baseUrl } = require("./_calendar-utils");

exports.handler = async (event) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return { statusCode: 500, body: "Missing GOOGLE_CLIENT_ID" };
  }

  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${baseUrl(event)}/.netlify/functions/google-auth-callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: "https://www.googleapis.com/auth/calendar.freebusy",
    include_granted_scopes: "true"
  });

  return {
    statusCode: 302,
    headers: { location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` },
    body: ""
  };
};
