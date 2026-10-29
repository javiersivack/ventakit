import type { MeliClient } from "./meli/client";
import type { Notification } from "./meli/notifications";
import { NeedsReauthError } from "./meli/tokens";
import { becamePaid, meliOrderSchema, type MeliOrder, type OrderStore, type UpsertResult } from "./orders";

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface ProcessDeps {
  client: MeliClient;
  orders: OrderStore;
  logger: Logger;
  // Se llama una sola vez por orden, cuando pasa a pagada. Acá va tu lógica (mail, stock, factura).
  onOrderPaid?: (order: MeliOrder) => Promise<void>;
}

// Procesa un aviso: relee el recurso con el token del vendedor y guarda solo si es más nuevo.
// Devuelve qué pasó con la orden, o null si el aviso se ignoró.
export async function processNotification(
  n: Pick<Notification, "topic" | "resource" | "user_id">,
  deps: ProcessDeps,
): Promise<UpsertResult | null> {
  const { client, orders, logger, onOrderPaid } = deps;
  if (n.topic !== "orders_v2") {
    logger.info("aviso ignorado", { topic: n.topic, resource: n.resource });
    return null;
  }
  let order: MeliOrder;
  try {
    order = await client.get(n.user_id, n.resource, meliOrderSchema);
  } catch (err) {
    if (err instanceof NeedsReauthError) {
      logger.warn("vendedor desconectado: hay que volver a conectar la cuenta", { userId: n.user_id });
      return null;
    }
    throw err;
  }
  if (order.seller.id !== n.user_id) {
    logger.warn("la orden no es de este vendedor", { userId: n.user_id, orderId: order.id });
    return null;
  }
  const { result, previousStatus } = await orders.upsertIfNewer(order);
  logger.info("orden procesada", { orderId: order.id, status: order.status, result });
  if (onOrderPaid && becamePaid(result, previousStatus, order)) await onOrderPaid(order);
  return result;
}
