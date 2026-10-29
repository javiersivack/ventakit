import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { exchangeCode, OAuthError } from "@/lib/meli/oauth";
import { fromTokenResponse } from "@/lib/meli/tokens";
import { app, logger, oauthConfig } from "@/lib/server";

const sameString = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Mercado Libre vuelve acá con ?code&state. Se valida el state contra la cookie (CSRF) y se
// cambia el code por tokens usando el code_verifier de PKCE.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const jar = await cookies();
  const expectedState = jar.get("meli_state")?.value;
  const verifier = jar.get("meli_verifier")?.value;
  jar.delete({ name: "meli_state", path: "/api/meli" });
  jar.delete({ name: "meli_verifier", path: "/api/meli" });

  if (!code || !state || !expectedState || !verifier || !sameString(state, expectedState)) {
    return NextResponse.json({ error: "invalid_state" }, { status: 400 });
  }
  try {
    const tokens = fromTokenResponse(await exchangeCode(oauthConfig(), code, verifier), Date.now());
    await app().tokenStore.save(tokens);
    logger.info("cuenta conectada", { userId: tokens.userId });
    return NextResponse.redirect(new URL(`/?connected=${tokens.userId}`, req.url));
  } catch (err) {
    logger.error("no se pudo conectar la cuenta", { error: String(err) });
    const status = err instanceof OAuthError && err.status < 500 ? 400 : 502;
    return NextResponse.json({ error: "oauth_failed" }, { status });
  }
}
