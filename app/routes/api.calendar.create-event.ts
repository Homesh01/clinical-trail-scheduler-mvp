import { json, type ActionFunctionArgs } from "@remix-run/cloudflare";

type CreateEventReq = {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  summary: string;
  description?: string;
  durationMinutes?: number; // default 60
  timeZone?: string; // default local/UTC
};

async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`refresh failed: ${resp.status} ${t}`);
  }
  const data = (await resp.json()) as { access_token: string };
  return data.access_token;
}

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const body = (await request.json().catch(() => ({}))) as CreateEventReq;
  const { date, time, summary, description = "", durationMinutes = 60, timeZone = "UTC" } = body;
  if (!date || !time || !summary) {
    return json({ error: "Missing date/time/summary" }, { status: 400 });
  }

  const cookie = request.headers.get("Cookie") || "";
  const mRefresh = /gcal_refresh=([^;]+)/.exec(cookie);
  const mAccess = /gcal_access=([^;]+)/.exec(cookie);
  if (!mRefresh && !mAccess) return json({ error: "Not connected" }, { status: 401 });
  const refreshToken = mRefresh ? decodeURIComponent(mRefresh[1]) : undefined;
  let accessToken = mAccess ? decodeURIComponent(mAccess[1]) : undefined;

  const clientId = (context as any).cloudflare?.env?.GOOGLE_CLIENT_ID as string | undefined;
  const clientSecret = (context as any).cloudflare?.env?.GOOGLE_CLIENT_SECRET as string | undefined;
  if (!clientId || !clientSecret) return json({ error: "Missing Google credentials" }, { status: 500 });

  if (!accessToken && refreshToken) {
    try {
      accessToken = await refreshAccessToken(refreshToken, clientId, clientSecret);
    } catch (e) {
      return json({ error: String(e) }, { status: 502 });
    }
  }
  if (!accessToken) return json({ error: "No access token" }, { status: 401 });

  const startDateTime = `${date}T${time}:00`;
  const end = new Date(`${startDateTime}Z`);
  end.setUTCMinutes(end.getUTCMinutes() + durationMinutes);
  const endIso = `${end.toISOString().slice(0, 19)}`;

  const resp = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      summary,
      description,
      start: { dateTime: startDateTime, timeZone },
      end: { dateTime: endIso, timeZone },
    }),
  });
  const text = await resp.text();
  if (!resp.ok) {
    return json({ error: "create failed", details: text }, { status: 502 });
  }
  const event = JSON.parse(text) as { id: string; htmlLink?: string };
  return json({ ok: true, eventId: event.id, htmlLink: event.htmlLink });
};


