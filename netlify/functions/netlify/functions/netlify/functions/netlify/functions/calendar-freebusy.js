const { decrypt, encrypt, json, parseCookies, rfc3339, setCookie } = require("./_calendar-utils");

async function refreshGoogleToken(token) {
  if (token.expiresAt && token.expiresAt > Date.now() + 60000) return { token, refreshed: false };
  if (!token.refreshToken) throw new Error("Google refresh token missing. Reconnect Google Calendar.");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      refresh_token: token.refreshToken,
      grant_type: "refresh_token"
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || "Google token refresh failed");

  return {
    refreshed: true,
    token: {
      ...token,
      accessToken: data.access_token,
      expiresAt: Date.now() + ((data.expires_in || 3600) * 1000)
    }
  };
}

async function googleBusy(cookie, timeMin, timeMax) {
  if (!cookie) throw new Error("Google Calendar is not connected.");
  const current = decrypt(cookie);
  const { token, refreshed } = await refreshGoogleToken(current);
  const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      timeMin,
      timeMax,
      timeZone: "Asia/Bangkok",
      items: [{ id: "primary" }]
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Google freebusy failed");
  return {
    busyBlocks: data.calendars?.primary?.busy || [],
    setCookie: refreshed ? setCookie("ao_google_calendar", encrypt(token)) : null
  };
}

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function caldavRequest(url, auth, body, depth = "0") {
  const response = await fetch(url, {
    method: body.includes("calendar-query") ? "REPORT" : "PROPFIND",
    headers: {
      authorization: auth,
      depth,
      "content-type": "application/xml; charset=utf-8"
    },
    body
  });
  const text = await response.text();
  if (!response.ok && response.status !== 207) throw new Error(`Apple CalDAV failed (${response.status})`);
  return text;
}

function firstHref(xml, pattern) {
  const match = xml.match(pattern);
  return match ? match[1] : null;
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#13;/g, "\r")
    .replace(/&#10;/g, "\n");
}

function calendarHrefs(xml) {
  return (xml.match(/<[^>]*response[\s\S]*?<\/[^>]*response>/g) || [])
    .filter(block => /<[^>]*calendar\b/i.test(block))
    .map(block => firstHref(block, /<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/))
    .filter(Boolean);
}

function parseIcsDate(value) {
  if (!value) return null;
  if (value.includes("T")) {
    const normalized = value.endsWith("Z")
      ? value.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z")
      : value.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3T$4:$5:$6+07:00");
    return new Date(normalized).toISOString();
  }
  return new Date(value.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3T00:00:00+07:00")).toISOString();
}

function parseCalendarData(xml) {
  const blocks = [];
  const decoded = decodeXmlText(xml);
  const matches = decoded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  matches.forEach(event => {
    const start = parseIcsDate((event.match(/DTSTART[^:]*:(.+)/) || [])[1]?.trim());
    const end = parseIcsDate((event.match(/DTEND[^:]*:(.+)/) || [])[1]?.trim());
    if (start && end) blocks.push({ start, end });
  });
  return blocks;
}

async function appleBusy(cookie, timeMin, timeMax) {
  if (!cookie) throw new Error("Apple Calendar is not connected.");
  const credential = decrypt(cookie);
  const auth = basicAuth(credential.username, credential.appPassword);
  const principalXml = await caldavRequest("https://caldav.icloud.com/", auth, `<?xml version="1.0" encoding="utf-8"?>
    <d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal /></d:prop></d:propfind>`);
  const principalHref = firstHref(principalXml, /<[^>]*current-user-principal[^>]*>[\s\S]*?<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/);
  if (!principalHref) throw new Error("Apple principal not found");

  const homeXml = await caldavRequest(`https://caldav.icloud.com${principalHref}`, auth, `<?xml version="1.0" encoding="utf-8"?>
    <d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:prop><cal:calendar-home-set /></d:prop></d:propfind>`);
  const homeHref = firstHref(homeXml, /<[^>]*calendar-home-set[^>]*>[\s\S]*?<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/);
  if (!homeHref) throw new Error("Apple calendar home not found");

  const calendarXml = await caldavRequest(`https://caldav.icloud.com${homeHref}`, auth, `<?xml version="1.0" encoding="utf-8"?>
    <d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype /></d:prop></d:propfind>`, "1");
  const hrefs = calendarHrefs(calendarXml);
  if (!hrefs.length) throw new Error("Apple writable calendars not found");

  const start = timeMin.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const end = timeMax.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const report = `<?xml version="1.0" encoding="utf-8"?>
    <cal:calendar-query xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
      <d:prop><cal:calendar-data /></d:prop>
      <cal:filter><cal:comp-filter name="VCALENDAR"><cal:comp-filter name="VEVENT"><cal:time-range start="${start}" end="${end}" /></cal:comp-filter></cal:comp-filter></cal:filter>
    </cal:calendar-query>`;
  const results = await Promise.allSettled(hrefs.map(href => caldavRequest(`https://caldav.icloud.com${href}`, auth, report, "1")));
  const busyBlocks = results
    .filter(result => result.status === "fulfilled")
    .flatMap(result => parseCalendarData(result.value));
  return { busyBlocks };
}

exports.handler = async (event) => {
  try {
    const source = event.queryStringParameters?.source || "google";
    const timeMin = rfc3339(event.queryStringParameters?.timeMin);
    const timeMax = rfc3339(event.queryStringParameters?.timeMax);
    const cookies = parseCookies(event.headers.cookie || "");
    const result = source === "apple"
      ? await appleBusy(cookies.ao_apple_calendar, timeMin, timeMax)
      : await googleBusy(cookies.ao_google_calendar, timeMin, timeMax);

    const headers = result.setCookie ? { "set-cookie": result.setCookie } : {};
    return json(200, { source, busyBlocks: result.busyBlocks, timeMin, timeMax }, headers);
  } catch (error) {
    return json(401, { error: error.message || "Calendar unavailable" });
  }
};
