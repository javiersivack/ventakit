import { createMeliClient, type MeliClient } from "@/lib/meli/client";
import { Coalescer } from "@/lib/meli/notifications";
import { AUTH_DOMAINS, type OAuthConfig, type SiteId } from "@/lib/meli/oauth";
import { MemoryTokenStore, TokenManager, type TokenStore } from "@/lib/meli/tokens";
import { MemoryOrderStore, type MeliOrder, type OrderStore } from "@/lib/orders";
import type { Logger } from "@/lib/process";

// Configuración de la app de ejemplo. Los stores en memoria sirven para probar en local; en
// producción implementá TokenStore y OrderStore sobre tu base (ver README).

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export const logger: Logger = {
  info: (msg, data) => console.log(JSON.stringify({ level: "info", msg, ...data })),
  warn: (msg, data) => console.warn(JSON.stringify({ level: "warn", msg, ...data })),
  error: (msg, data) => console.error(JSON.stringify({ level: "error", msg, ...data })),
};

export function oauthConfig(): OAuthConfig {
  const siteId = (process.env.MELI_SITE_ID ?? "MLA") as SiteId;
  if (!(siteId in AUTH_DOMAINS)) throw new Error(`MELI_SITE_ID inválido: ${siteId}`);
  return {
    clientId: requireEnv("MELI_CLIENT_ID"),
    clientSecret: requireEnv("MELI_CLIENT_SECRET"),
    redirectUri: requireEnv("MELI_REDIRECT_URI"),
    siteId,
  };
}

export const applicationId = () => Number(requireEnv("MELI_CLIENT_ID"));

// Se llama una sola vez por orden, cuando pasa a pagada. Acá va tu lógica: mail, stock, factura.
export async function onOrderPaid(order: MeliOrder): Promise<void> {
  logger.info("orden pagada", { orderId: order.id, total: order.total_amount });
}

interface Singletons {
  tokenStore: TokenStore;
  tokens: TokenManager;
  client: MeliClient;
  orders: OrderStore;
  coalescer: Coalescer;
}
const g = globalThis as unknown as { ventakit?: Singletons };

export function app(): Singletons {
  if (!g.ventakit) {
    const tokenStore = new MemoryTokenStore();
    const tokens = new TokenManager({ oauth: oauthConfig(), store: tokenStore });
    g.ventakit = {
      tokenStore,
      tokens,
      client: createMeliClient({ tokens }),
      orders: new MemoryOrderStore(),
      coalescer: new Coalescer(),
    };
  }
  return g.ventakit;
}
