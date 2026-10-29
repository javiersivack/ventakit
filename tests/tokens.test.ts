import { describe, expect, it } from "vitest";
import { MemoryTokenStore, NeedsReauthError, REFRESH_MARGIN_MS, TokenManager } from "@/lib/meli/tokens";
import { fakeFetch, json, oauth, tokenBody } from "./helpers";

const HOUR = 60 * 60 * 1000;

async function setup(expiresInMs: number, handler: Parameters<typeof fakeFetch>[0]) {
  let now = 1_000_000;
  const store = new MemoryTokenStore();
  await store.save({ userId: 42, accessToken: "APP_USR-access-0", refreshToken: "TG-refresh-0", expiresAt: now + expiresInMs, needsReauth: false });
  const f = fakeFetch(handler);
  const manager = new TokenManager({ oauth: oauth(f.fn), store, now: () => now });
  return { store, f, manager, advance: (ms: number) => (now += ms) };
}

describe("TokenManager", () => {
  it("usa el token guardado mientras le quede más del margen", async () => {
    const { f, manager } = await setup(5 * HOUR, () => json(200, tokenBody(1)));
    expect(await manager.getAccessToken(42)).toBe("APP_USR-access-0");
    expect(f.calls).toHaveLength(0);
  });

  it("renueva antes de que venza y guarda el refresh token nuevo", async () => {
    const { store, f, manager } = await setup(REFRESH_MARGIN_MS - 1, () => json(200, tokenBody(1)));
    expect(await manager.getAccessToken(42)).toBe("APP_USR-access-1");
    expect(new URLSearchParams(String(f.calls[0]!.init.body)).get("refresh_token")).toBe("TG-refresh-0");
    expect((await store.get(42))?.refreshToken).toBe("TG-refresh-1");
  });

  it("muchos pedidos a la vez hacen una sola renovación (el refresh token es de un solo uso)", async () => {
    let n = 0;
    const { f, manager } = await setup(0, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return json(200, tokenBody(++n));
    });
    const tokens = await Promise.all(Array.from({ length: 10 }, () => manager.getAccessToken(42)));
    expect(f.calls).toHaveLength(1);
    expect(new Set(tokens)).toEqual(new Set(["APP_USR-access-1"]));
  });

  it("después de renovar no vuelve a renovar", async () => {
    let n = 0;
    const { f, manager, advance } = await setup(0, () => json(200, tokenBody(++n)));
    await manager.getAccessToken(42);
    advance(HOUR);
    await manager.getAccessToken(42);
    expect(f.calls).toHaveLength(1);
  });

  it("invalid_grant marca la cuenta para volver a conectar y no reintenta", async () => {
    const { store, f, manager } = await setup(0, () => json(400, { error: "invalid_grant" }));
    await expect(manager.getAccessToken(42)).rejects.toBeInstanceOf(NeedsReauthError);
    expect((await store.get(42))?.needsReauth).toBe(true);
    await expect(manager.getAccessToken(42)).rejects.toBeInstanceOf(NeedsReauthError);
    expect(f.calls).toHaveLength(1);
  });

  it("un error temporal no desconecta la cuenta", async () => {
    const { store, manager } = await setup(0, () => json(503, {}));
    await expect(manager.getAccessToken(42)).rejects.toThrow();
    expect((await store.get(42))?.needsReauth).toBe(false);
  });

  it("force renueva aunque no haya vencido (después de un 401), una sola vez", async () => {
    let n = 0;
    const { f, manager } = await setup(5 * HOUR, () => json(200, tokenBody(++n)));
    const [a, b] = await Promise.all([
      manager.getAccessToken(42, { force: true }),
      manager.getAccessToken(42, { force: true }),
    ]);
    expect(a).toBe("APP_USR-access-1");
    expect(b).toBe("APP_USR-access-1");
    expect(f.calls).toHaveLength(1);
  });

  it("cuenta que nunca se conectó", async () => {
    const { manager } = await setup(5 * HOUR, () => json(200, {}));
    await expect(manager.getAccessToken(99)).rejects.toBeInstanceOf(NeedsReauthError);
  });
});
