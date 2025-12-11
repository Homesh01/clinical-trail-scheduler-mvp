import { json, redirect, type LoaderFunctionArgs } from "@remix-run/cloudflare";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  if (!code || !returnedState) {
    return json({ error: "Missing code/state" }, { status: 400 });
  }

  const cookie = request.headers.get("Cookie") || "";
  const match = /gcal_oauth=([^;]+)/.exec(cookie);
  if (!match) return json({ error: "Missing oauth cookie" }, { status: 400 });
  let stored: { state: string; codeVerifier: string } | null = null;
  try {
    stored = JSON.parse(decodeURIComponent(match[1]));
  } catch {
    return json({ error: "Invalid oauth cookie" }, { status: 400 });
  }
  if (!stored || stored.state !== returnedState) {
    return json({ error: "State mismatch" }, { status: 400 });
  }

  const clientId = (context as any).cloudflare?.env?.GOOGLE_CLIENT_ID as
    | string
    | undefined;
  const clientSecret = (context as any).cloudflare?.env
    ?.GOOGLE_CLIENT_SECRET as string | undefined;
  if (!clientId || !clientSecret) {
    return json({ error: "Missing Google credentials" }, { status: 500 });
  }

  const redirectUri = url.origin.replace(/\/$/, "") + "/auth/google/callback";

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: stored.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenResp.ok) {
    const text = await tokenResp.text();
    return json(
      { error: "Token exchange failed", details: text },
      { status: 502 }
    );
  }
  const tokens = (await tokenResp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
    scope: string;
  };

  // Store refresh_token in an HttpOnly cookie (dev convenience).
  // For production, prefer KV or Durable Object.
  const headers = new Headers();
  const secureFlag = url.protocol === "http:" ? "" : " Secure;";
  headers.append(
    "Set-Cookie",
    `gcal_oauth=; Path=/; Max-Age=0; HttpOnly;${secureFlag} SameSite=Lax`
  );
  // Always set a short-lived access token cookie so the app can work
  // even if Google doesn't return a refresh_token in this grant.
  if (tokens.access_token) {
    const maxAge = Math.max(60, tokens.expires_in - 60); // pad a minute
    headers.append(
      "Set-Cookie",
      `gcal_access=${encodeURIComponent(
        tokens.access_token
      )}; Path=/; HttpOnly;${secureFlag} SameSite=Lax; Max-Age=${maxAge}`
    );
  }
  if (tokens.refresh_token) {
    headers.append(
      "Set-Cookie",
      `gcal_refresh=${encodeURIComponent(
        tokens.refresh_token
      )}; Path=/; HttpOnly;${secureFlag} SameSite=Lax; Max-Age=${
        60 * 60 * 24 * 30
      }`
    );
  }
  return redirect("/", { headers });
};

export default function _() {
  return null;
}
