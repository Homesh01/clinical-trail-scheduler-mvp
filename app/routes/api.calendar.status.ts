import { json, type LoaderFunctionArgs } from "@remix-run/cloudflare";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const cookie = request.headers.get("Cookie") || "";
  const hasRefresh = /gcal_refresh=([^;]+)/.test(cookie);
  const hasAccess = /gcal_access=([^;]+)/.test(cookie);
  return json({ connected: hasRefresh || hasAccess });
};


