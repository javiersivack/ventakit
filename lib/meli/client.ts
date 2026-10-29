import type { z } from "zod";
import type { TokenManager } from "./tokens";

export class MeliApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MeliApiError";
  }
}

export interface MeliClientOptions {
  tokens: TokenManager;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Cliente por vendedor: cada pedido usa el token de ese vendedor. Reintenta 429 y 5xx con
// backoff (respeta Retry-After) y, ante un 401, renueva el token una vez y repite.
export function createMeliClient(options: MeliClientOptions) {
  const {
    tokens,
    baseUrl = "https://api.mercadolibre.com",
    fetchImpl = fetch,
    timeoutMs = 10_000,
    maxRetries = 3,
    sleep = defaultSleep,
  } = options;

  async function request<T>(
    userId: number,
    method: "GET" | "PUT" | "POST",
    path: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    body?: unknown,
  ): Promise<T> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await tokens.getAccessToken(userId, { force: refreshed });
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        if (attempt < maxRetries) {
          await sleep(backoff(attempt, null));
          continue;
        }
        throw new MeliApiError(`${method} ${path}: sin respuesta`, null, true);
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await sleep(backoff(attempt, res.headers.get("retry-after")));
        continue;
      }
      if (!res.ok) {
        throw new MeliApiError(`${method} ${path} respondió ${res.status}`, res.status, res.status === 429 || res.status >= 500);
      }
      return schema.parse(await res.json());
    }
  }

  return {
    get: <T>(userId: number, path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>) =>
      request(userId, "GET", path, schema),
    put: <T>(userId: number, path: string, body: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>) =>
      request(userId, "PUT", path, schema, body),
  };
}

export type MeliClient = ReturnType<typeof createMeliClient>;

function backoff(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  return 500 * 2 ** attempt;
}
