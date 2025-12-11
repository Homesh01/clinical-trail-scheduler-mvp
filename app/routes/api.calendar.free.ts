import { json, type ActionFunctionArgs } from "@remix-run/cloudflare";

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

type FreeBusyReq = {
  date: string; // YYYY-MM-DD
  timeZone?: string; // e.g., "America/Los_Angeles"
  workStart?: string; // "09:00"
  workEnd?: string; // "17:00"
  slotMinutes?: number; // e.g., 30
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const body = (await request.json().catch(() => ({}))) as FreeBusyReq;
  const { date, timeZone = "UTC", workStart = "09:00", workEnd = "17:00", slotMinutes = 30 } = body;
  if (!date) return json({ error: "Missing date" }, { status: 400 });

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

  // Build RFC3339 start/end for the day in given timezone (approximate by appending time; Google interprets timeZone)
  const startDateTime = `${date}T00:00:00`;
  const endDateTime = `${date}T23:59:59`;

  const fbResp = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      timeMin: startDateTime + "Z",
      timeMax: endDateTime + "Z",
      timeZone,
      items: [{ id: "primary" }],
    }),
  });
  if (!fbResp.ok) {
    const t = await fbResp.text();
    return json({ error: "freeBusy failed", details: t }, { status: 502 });
  }
  const fb = (await fbResp.json()) as {
    calendars: { primary: { busy: Array<{ start: string; end: string }> } };
  };
  const busy = fb.calendars?.primary?.busy || [];

  // Construct working window intervals
  const [wsH, wsM] = workStart.split(":").map((n) => parseInt(n, 10));
  const [weH, weM] = workEnd.split(":").map((n) => parseInt(n, 10));
  const dayStart = new Date(`${date}T${String(wsH).padStart(2, "0")}:${String(wsM).padStart(2, "0")}:00Z`).getTime();
  const dayEnd = new Date(`${date}T${String(weH).padStart(2, "0")}:${String(weM).padStart(2, "0")}:00Z`).getTime();

  // Generate all slots
  const slots: string[] = [];
  const stepMs = slotMinutes * 60 * 1000;
  for (let t = dayStart; t + stepMs <= dayEnd; t += stepMs) {
    const slotStart = t;
    const slotEnd = t + stepMs;
    // Check overlap with busy intervals (convert busy to ms)
    const overlaps = busy.some((b) => {
      const bStart = Date.parse(b.start);
      const bEnd = Date.parse(b.end);
      return Math.max(slotStart, bStart) < Math.min(slotEnd, bEnd);
    });
    if (!overlaps) {
      const d = new Date(slotStart);
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const mm = String(d.getUTCMinutes()).padStart(2, "0");
      slots.push(`${hh}:${mm}`);
    }
  }

  return json({ date, timeZone, slots });
};


