import type { OAuthConfig } from "@/lib/meli/oauth";
import type { Logger } from "@/lib/process";

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

export function tokenBody(n: number, userId = 42) {
  return {
    access_token: `APP_USR-access-${n}`,
    token_type: "Bearer",
    expires_in: 21600,
    scope: "offline_access read write",
    user_id: userId,
    refresh_token: `TG-refresh-${n}`,
  };
}

// fetch falso: responde con la función que se le pase y guarda cada pedido.
export function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

export const oauth = (fetchImpl: typeof fetch): OAuthConfig => ({
  clientId: "123",
  clientSecret: "secret",
  redirectUri: "https://example.com/api/meli/callback",
  siteId: "MLU",
  fetchImpl,
});

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 2000001,
    status: "paid",
    last_updated: "2026-10-28T12:00:00.000-03:00",
    total_amount: 1500,
    currency_id: "UYU",
    seller: { id: 42 },
    buyer: { id: 7 },
    order_items: [{ item: { id: "MLU123", variation_id: null }, quantity: 1 }],
    ...overrides,
  };
}
