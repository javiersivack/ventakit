import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAuthUrl, createPkce, exchangeCode, OAuthError, refreshTokens } from "@/lib/meli/oauth";
import { fakeFetch, json, oauth, tokenBody } from "./helpers";

describe("oauth", () => {
  it("PKCE: el challenge es el SHA-256 del verifier en base64url", () => {
    const { verifier, challenge } = createPkce();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("arma la URL de autorización del país del vendedor", () => {
    const url = new URL(buildAuthUrl(oauth(fetch), "st", "ch"));
    expect(url.host).toBe("auth.mercadolibre.com.uy");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "123",
      redirect_uri: "https://example.com/api/meli/callback",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
    });
  });

  it("cambia el code por tokens mandando redirect_uri y code_verifier", async () => {
    const f = fakeFetch(() => json(200, tokenBody(1)));
    const res = await exchangeCode(oauth(f.fn), "TG-code", "verif");
    expect(res.refresh_token).toBe("TG-refresh-1");
    const sent = new URLSearchParams(String(f.calls[0]!.init.body));
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code_verifier")).toBe("verif");
    expect(sent.get("redirect_uri")).toBe("https://example.com/api/meli/callback");
  });

  it("invalid_grant al renovar pide volver a conectar", async () => {
    const f = fakeFetch(() => json(400, { error: "invalid_grant", message: "invalid_grant" }));
    const err = await refreshTokens(oauth(f.fn), "TG-old").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).needsReauth).toBe(true);
  });

  it("otros errores no piden volver a conectar", async () => {
    const f = fakeFetch(() => json(500, { error: "internal_error" }));
    const err = (await refreshTokens(oauth(f.fn), "TG-x").catch((e: unknown) => e)) as OAuthError;
    expect(err.needsReauth).toBe(false);
    expect(err.status).toBe(500);
  });
});
