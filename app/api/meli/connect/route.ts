import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { buildAuthUrl, createPkce, createState } from "@/lib/meli/oauth";
import { oauthConfig } from "@/lib/server";

// Empieza la conexión de una cuenta vendedora: guarda state y code_verifier en cookies
// httpOnly y manda al vendedor a autorizar la app en Mercado Libre.
export async function GET() {
  const { verifier, challenge } = createPkce();
  const state = createState();
  const jar = await cookies();
  const opts = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/api/meli", maxAge: 600 };
  jar.set("meli_state", state, opts);
  jar.set("meli_verifier", verifier, opts);
  return NextResponse.redirect(buildAuthUrl(oauthConfig(), state, challenge));
}
