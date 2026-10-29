import { z } from "zod";

// Lo mínimo de GET /orders/{id} que usa el kit. passthrough: el resto se guarda tal cual.
export const meliOrderSchema = z
  .object({
    id: z.number(),
    status: z.string(),
    last_updated: z.string(),
    total_amount: z.number(),
    currency_id: z.string(),
    seller: z.object({ id: z.number() }),
    buyer: z.object({ id: z.number() }),
    order_items: z.array(
      z
        .object({
          item: z.object({ id: z.string(), variation_id: z.number().nullable().optional() }).passthrough(),
          quantity: z.number(),
        })
        .passthrough(),
    ),
    pack_id: z.number().nullable().optional(),
  })
  .passthrough();
export type MeliOrder = z.infer<typeof meliOrderSchema>;

export interface StoredOrder {
  id: number;
  sellerId: number;
  status: string;
  lastUpdated: string;
  order: MeliOrder;
}

export type UpsertResult = "created" | "updated" | "unchanged" | "stale";

export interface OrderStore {
  get(id: number): Promise<StoredOrder | null>;
  // Guarda solo si `order` es más nuevo que lo guardado (compare-and-set por fecha).
  upsertIfNewer(order: MeliOrder): Promise<{ result: UpsertResult; previousStatus: string | null }>;
}

const toStored = (order: MeliOrder): StoredOrder => ({
  id: order.id,
  sellerId: order.seller.id,
  status: order.status,
  lastUpdated: order.last_updated,
  order,
});

// Una lectura de la API puede llegar después de otra más nueva (dos avisos procesados en
// paralelo). Se compara last_updated para que una lectura vieja nunca pise una nueva.
export class MemoryOrderStore implements OrderStore {
  private readonly data = new Map<number, StoredOrder>();

  async get(id: number) {
    return this.data.get(id) ?? null;
  }

  async upsertIfNewer(order: MeliOrder) {
    const prev = this.data.get(order.id);
    if (!prev) {
      this.data.set(order.id, toStored(order));
      return { result: "created" as const, previousStatus: null };
    }
    const cmp = Date.parse(order.last_updated) - Date.parse(prev.lastUpdated);
    if (cmp < 0) return { result: "stale" as const, previousStatus: prev.status };
    // last_updated viene en segundos: dos cambios en el mismo segundo empatan. Ante un empate con
    // otro estado, gana la lectura más reciente.
    if (cmp === 0 && order.status === prev.status) return { result: "unchanged" as const, previousStatus: prev.status };
    this.data.set(order.id, toStored(order));
    return { result: "updated" as const, previousStatus: prev.status };
  }
}

// Disparar efectos (mail, descontar stock propio) solo cuando la orden pasa a "paid" por
// primera vez, no por cada aviso.
export function becamePaid(result: UpsertResult, previousStatus: string | null, order: MeliOrder): boolean {
  return (result === "created" || result === "updated") && order.status === "paid" && previousStatus !== "paid";
}
