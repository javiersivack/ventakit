import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

// Dominio de autorización por país: el vendedor inicia sesión en el sitio de su país.
export const AUTH_DOMAINS = {
  MLA: "auth.mercadolibre.com.ar",
  MLB: "auth.mercadolivre.com.br",
  MLM: "auth.mercadolibre.com.mx",
  MLU: "auth.mercadolibre.com.uy",
  MLC: "auth.mercadolibre.cl",
  MCO: "auth.mercadolibre.com.co",
  MPE: "auth.mercadolibre.com.pe",
} as const;
export type SiteId = keyof typeof AUTH_DOMAINS;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  siteId: SiteId;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export const tokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  scope: z.string().optional(),
  user_id: z.number(),
  refresh_token: z.string(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    // invalid_grant: el refresh token ya se usó, venció o el vendedor revocó el acceso.
    // No se arregla reintentando: hay que pedirle al vendedor que vuelva a conectar.
    readonly code: string | null,
  ) {
    super(message);
    this.name = "OAuthError";
  }
  get needsReauth(): boolean {
    return this.code === "invalid_grant";
  }
}

const base64url = (buf: Buffer) => buf.toString("base64url");

// PKCE (S256): el code_verifier queda en una cookie y nunca viaja en la URL.
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function createState(): string {
  return base64url(randomBytes(16));
}

export function buildAuthUrl(config: OAuthConfig, state: string, codeChallenge: string): string {
  const url = new URL(`https://${AUTH_DOMAINS[config.siteId]}/authorization`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function postToken(config: OAuthConfig, params: Record<string, string>): Promise<TokenResponse> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const res = await fetchImpl(`${config.apiBaseUrl ?? "https://api.mercadolibre.com"}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...params }),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code = typeof body === "object" && body && "error" in body ? String(body.error) : null;
    throw new OAuthError(`oauth/token respondió ${res.status}`, res.status, code);
  }
  return tokenResponseSchema.parse(body);
}

export function exchangeCode(config: OAuthConfig, code: string, codeVerifier: string): Promise<TokenResponse> {
  return postToken(config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  });
}

export function refreshTokens(config: OAuthConfig, refreshToken: string): Promise<TokenResponse> {
  return postToken(config, { grant_type: "refresh_token", refresh_token: refreshToken });
}
