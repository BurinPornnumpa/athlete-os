const { baseUrl, encrypt, setCookie } = require("./_calendar-utils");

exports.handler = async (event) => {
  const code = event.queryStringParameters && event.queryStringParameters.code;
  if (!code) return { statusCode: 400, body: "Missing OAuth code" };

  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${baseUrl(event)}/.netlify/functions/google-auth-callback`;
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok) {
    return { statusCode: 400, body: token.error_description || token.error || "Google token exchange failed" };
  }

  const cookieValue = encrypt({
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + ((token.expires_in || 3600) * 1000)
  });

  return {
    statusCode: 302,
    headers: {
      "set-cookie": setCookie("ao_google_calendar", cookieValue),
      location: "/athlete-os-v9.html?calendar=google"
    },
    body: ""
  };
};
