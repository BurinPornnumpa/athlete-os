const { encrypt, json, setCookie } = require("./_calendar-utils");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  const body = JSON.parse(event.body || "{}");
  if (!body.username || !body.appPassword) {
    return json(400, { error: "Apple ID and app-specific password are required" });
  }

  const cookieValue = encrypt({
    username: body.username,
    appPassword: body.appPassword
  });

  return json(200, { ok: true }, {
    "set-cookie": setCookie("ao_apple_calendar", cookieValue)
  });
};
