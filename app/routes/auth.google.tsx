import { redirect, type LoaderFunctionArgs } from "@remix-run/cloudflare";

function base64url(input: ArrayBuffer): string {
  const bytes = new Uint8Array(input);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64url(digest);
}

function randomString(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return base64url(arr.buffer);
}

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const redirectUri = url.origin.replace(/\/$/, "") + "/auth/google/callback";

  const clientId = (context as any).cloudflare?.env?.GOOGLE_CLIENT_ID as
    | string
    | undefined;
  if (!clientId) {
    return new Response("Missing GOOGLE_CLIENT_ID", { status: 500 });
  }

  const state = randomString(16);
  const codeVerifier = randomString(64);
  const codeChallenge = await sha256(codeVerifier);

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set(
    "scope",
    "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly"
  );
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  const headers = new Headers();
  // In dev over http, omit Secure so cookie is accepted. In https, keep Secure.
  const secureFlag = url.protocol === "http:" ? "" : " Secure;";
  headers.append(
    "Set-Cookie",
    `gcal_oauth=${encodeURIComponent(
      JSON.stringify({ state, codeVerifier })
    )}; Path=/; HttpOnly;${secureFlag} SameSite=Lax; Max-Age=600`
  );
  return redirect(authUrl.toString(), { headers });
};

export default function _() {
  return null;
}
