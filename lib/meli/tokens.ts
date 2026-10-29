import { OAuthError, refreshTokens, type OAuthConfig, type TokenResponse } from "./oauth";

export interface SellerTokens {
  userId: number;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  // true cuando la renovación devolvió invalid_grant: hay que volver a conectar la cuenta.
  needsReauth: boolean;
}

export interface TokenStore {
  get(userId: number): Promise<SellerTokens | null>;
  save(tokens: SellerTokens): Promise<void>;
  // Opcional: un lock por vendedor que cubra a todas las instancias (p. ej. un advisory lock de
  // Postgres). fn recibe un store que lee y guarda dentro del lock. Sin esto, solo se evitan
  // renovaciones dobles dentro del mismo proceso.
  withRefreshLock?<T>(userId: number, fn: (locked: TokenStore) => Promise<T>): Promise<T>;
}

export class MemoryTokenStore implements TokenStore {
  private readonly data = new Map<number, SellerTokens>();
  async get(userId: number) {
    return this.data.get(userId) ?? null;
  }
  async save(tokens: SellerTokens) {
    this.data.set(tokens.userId, { ...tokens });
  }
}

export class NeedsReauthError extends Error {
  constructor(readonly userId: number) {
    super(`El vendedor ${userId} tiene que volver a conectar su cuenta`);
    this.name = "NeedsReauthError";
  }
}

export function fromTokenResponse(res: TokenResponse, now: number): SellerTokens {
  return {
    userId: res.user_id,
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expiresAt: now + res.expires_in * 1000,
    needsReauth: false,
  };
}

// El access token dura 6 h. Se renueva con 1 h de margen para que un pedido largo o un reloj
// desfasado no lo use vencido.
export const REFRESH_MARGIN_MS = 60 * 60 * 1000;

export interface TokenManagerOptions {
  oauth: OAuthConfig;
  store: TokenStore;
  now?: () => number;
}

// El refresh token es de un solo uso: si dos pedidos lo renuevan a la vez, el segundo recibe
// invalid_grant y la cuenta queda desconectada. Por eso hay una sola renovación en curso por
// vendedor y el resto la espera. Con varias instancias, el store pone además un lock entre
// procesos (withRefreshLock) y doRefresh relee el token antes de renovar.
export class TokenManager {
  private readonly inFlight = new Map<number, Promise<SellerTokens>>();
  private readonly now: () => number;

  constructor(private readonly options: TokenManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(userId: number, { force = false } = {}): Promise<string> {
    const tokens = await this.options.store.get(userId);
    if (!tokens || tokens.needsReauth) throw new NeedsReauthError(userId);
    if (!force && tokens.expiresAt - this.now() > REFRESH_MARGIN_MS) return tokens.accessToken;
    return (await this.refresh(userId, force ? tokens.accessToken : null)).accessToken;
  }

  private refresh(userId: number, staleAccessToken: string | null): Promise<SellerTokens> {
    const running = this.inFlight.get(userId);
    if (running) return running;
    const { store } = this.options;
    const run = (locked: TokenStore) => this.doRefresh(locked, userId, staleAccessToken);
    const job = (store.withRefreshLock ? store.withRefreshLock(userId, run) : run(store)).finally(() =>
      this.inFlight.delete(userId),
    );
    this.inFlight.set(userId, job);
    return job;
  }

  private async doRefresh(store: TokenStore, userId: number, staleAccessToken: string | null): Promise<SellerTokens> {
    const { oauth } = this.options;
    // Releer: otra renovación pudo terminar mientras esperábamos.
    const current = await store.get(userId);
    if (!current || current.needsReauth) throw new NeedsReauthError(userId);
    const alreadyFresh = staleAccessToken
      ? current.accessToken !== staleAccessToken
      : current.expiresAt - this.now() > REFRESH_MARGIN_MS;
    if (alreadyFresh) return current;
    try {
      const next = fromTokenResponse(await refreshTokens(oauth, current.refreshToken), this.now());
      await store.save(next);
      return next;
    } catch (err) {
      if (err instanceof OAuthError && err.needsReauth) {
        await store.save({ ...current, needsReauth: true });
        throw new NeedsReauthError(userId);
      }
      throw err;
    }
  }
}
