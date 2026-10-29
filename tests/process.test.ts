import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMeliClient, MeliApiError } from "@/lib/meli/client";
import { Coalescer, parseNotification } from "@/lib/meli/notifications";
import { MemoryTokenStore, TokenManager } from "@/lib/meli/tokens";
import { MemoryOrderStore, type MeliOrder } from "@/lib/orders";
import { processNotification } from "@/lib/process";
import { fakeFetch, json, oauth, order, silentLogger, tokenBody } from "./helpers";

const HOUR = 60 * 60 * 1000;

async function setup(api: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const store = new MemoryTokenStore();
  await store.save({ userId: 42, accessToken: "APP_USR-access-0", refreshToken: "TG-refresh-0", expiresAt: Date.now() + 5 * HOUR, needsReauth: false });
  let n = 0;
  const f = fakeFetch((url, init) => (url.endsWith("/oauth/token") ? json(200, tokenBody(++n)) : api(url, init)));
  const tokens = new TokenManager({ oauth: oauth(f.fn), store });
  const client = createMeliClient({ tokens, fetchImpl: f.fn, sleep: async () => {} });
  const orders = new MemoryOrderStore();
  const paid: MeliOrder[] = [];
  const deps = { client, orders, logger: silentLogger, onOrderPaid: async (o: MeliOrder) => void paid.push(o) };
  return { f, client, orders, paid, deps, store };
}

const notif = (overrides: Record<string, unknown> = {}) => ({
  resource: "/orders/2000001",
  user_id: 42,
  topic: "orders_v2",
  application_id: 123,
  attempts: 1,
  sent: "2026-10-28T15:00:00.000Z",
  received: "2026-10-28T15:00:00.000Z",
  ...overrides,
});

describe("parseNotification", () => {
  it("acepta avisos de nuestra aplicación", () => {
    expect(parseNotification(notif(), 123).ok).toBe(true);
  });
  it("descarta avisos de otra aplicación o con cuerpo inválido", () => {
    expect(parseNotification(notif({ application_id: 999 }), 123)).toEqual({ ok: false, reason: "wrong_application" });
    expect(parseNotification({ hola: 1 }, 123)).toEqual({ ok: false, reason: "invalid_body" });
    expect(parseNotification(notif({ resource: "https://evil.example/x" }), 123)).toEqual({ ok: false, reason: "invalid_body" });
  });
});

describe("cliente", () => {
  const schema = z.object({ ok: z.boolean() });

  it("reintenta 429 y 5xx", async () => {
    let calls = 0;
    const { client } = await setup(() => (++calls < 3 ? json(calls === 1 ? 429 : 503, {}) : json(200, { ok: true })));
    expect(await client.get(42, "/x", schema)).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it("ante un 401 renueva el token una vez y repite", async () => {
    const auths: string[] = [];
    const { client, f } = await setup((_url, init) => {
      const auth = (init.headers as Record<string, string>).Authorization!;
      auths.push(auth);
      return auth.endsWith("access-0") ? json(401, {}) : json(200, { ok: true });
    });
    expect(await client.get(42, "/x", schema)).toEqual({ ok: true });
    expect(auths).toEqual(["Bearer APP_USR-access-0", "Bearer APP_USR-access-1"]);
    expect(f.calls.filter((c) => c.url.endsWith("/oauth/token"))).toHaveLength(1);
  });

  it("no reintenta un 404", async () => {
    let calls = 0;
    const { client } = await setup(() => (calls++, json(404, {})));
    const err = (await client.get(42, "/x", schema).catch((e: unknown) => e)) as MeliApiError;
    expect(err.status).toBe(404);
    expect(calls).toBe(1);
  });
});

describe("processNotification", () => {
  it("lee la orden de la API (no del aviso) y avisa una sola vez que se pagó", async () => {
    const { deps, orders, paid } = await setup(() => json(200, order()));
    await processNotification(parseOk(notif()), deps);
    await processNotification(parseOk(notif({ attempts: 2 })), deps);
    expect((await orders.get(2000001))?.status).toBe("paid");
    expect(paid).toHaveLength(1);
  });

  it("una lectura vieja que llega tarde no pisa una más nueva", async () => {
    const { deps, orders } = await setup(() => json(200, order()));
    await processNotification(parseOk(notif()), deps);
    const stale = order({ status: "payment_required", last_updated: "2026-10-28T11:00:00.000-03:00" });
    expect(await orders.upsertIfNewer(stale as MeliOrder)).toEqual({ result: "stale", previousStatus: "paid" });
    expect((await orders.get(2000001))?.status).toBe("paid");
  });

  it("dos cambios en el mismo segundo: el estado nuevo no se descarta", async () => {
    let current = order({ status: "payment_required" });
    const { deps, orders, paid } = await setup(() => json(200, current));
    await processNotification(parseOk(notif()), deps);
    current = order();
    await processNotification(parseOk(notif()), deps);
    expect((await orders.get(2000001))?.status).toBe("paid");
    expect(paid).toHaveLength(1);
  });

  it("de pendiente a pagada dispara el efecto; cancelada después no", async () => {
    let current = order({ status: "payment_required", last_updated: "2026-10-28T11:00:00.000-03:00" });
    const { deps, paid } = await setup(() => json(200, current));
    await processNotification(parseOk(notif()), deps);
    expect(paid).toHaveLength(0);
    current = order();
    await processNotification(parseOk(notif()), deps);
    expect(paid).toHaveLength(1);
    current = order({ status: "cancelled", last_updated: "2026-10-28T13:00:00.000-03:00" });
    await processNotification(parseOk(notif()), deps);
    expect(paid).toHaveLength(1);
  });

  it("ignora una orden que no es del vendedor del aviso", async () => {
    const { deps, orders } = await setup(() => json(200, order({ seller: { id: 999 } })));
    await processNotification(parseOk(notif()), deps);
    expect(await orders.get(2000001)).toBeNull();
  });

  it("vendedor desconectado: no tira error, lo deja anotado", async () => {
    const { deps, store, orders } = await setup(() => json(200, order()));
    await store.save({ ...(await store.get(42))!, needsReauth: true });
    await expect(processNotification(parseOk(notif()), deps)).resolves.toBeNull();
    expect(await orders.get(2000001)).toBeNull();
  });

  it("ignora tópicos que el kit no maneja", async () => {
    const { deps, f } = await setup(() => json(200, {}));
    await processNotification(parseOk(notif({ topic: "questions", resource: "/questions/1" })), deps);
    expect(f.calls).toHaveLength(0);
  });
});

describe("Coalescer", () => {
  it("varios avisos del mismo recurso mientras se procesa: una relectura extra, no diez", async () => {
    const c = new Coalescer();
    let runs = 0;
    const task = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 10));
    };
    await Promise.all(Array.from({ length: 10 }, () => c.run("42:/orders/1", task)));
    expect(runs).toBe(2);
  });

  it("recursos distintos corren por separado", async () => {
    const c = new Coalescer();
    let runs = 0;
    await Promise.all([c.run("a", async () => void runs++), c.run("b", async () => void runs++)]);
    expect(runs).toBe(2);
  });
});

function parseOk(body: unknown) {
  const r = parseNotification(body, 123);
  if (!r.ok) throw new Error(r.reason);
  return r.notification;
}
