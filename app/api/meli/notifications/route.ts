import { after, NextResponse, type NextRequest } from "next/server";
import { notificationKey, parseNotification } from "@/lib/meli/notifications";
import { processNotification } from "@/lib/process";
import { app, applicationId, logger, onOrderPaid } from "@/lib/server";

// Mercado Libre espera un 200 casi inmediato y, si no llega, reintenta y termina dejando de
// mandar el tópico. Por eso se responde primero y se procesa después con after(). Si el
// proceso falla, el próximo aviso del mismo recurso relee el estado completo (y en la Pro, la
// conciliación por cron relee las órdenes recientes).
export async function POST(req: NextRequest) {
  const body: unknown = await req.json().catch(() => null);
  const parsed = parseNotification(body, applicationId());
  if (!parsed.ok) {
    logger.warn("aviso descartado", { reason: parsed.reason });
    // 200 igual: reintentar un aviso inválido no lo arregla.
    return NextResponse.json({ ok: false });
  }
  const n = parsed.notification;
  const { client, orders, coalescer } = app();
  after(() =>
    coalescer
      .run(notificationKey(n), async () => {
        await processNotification(n, { client, orders, logger, onOrderPaid });
      })
      .catch((err) => logger.error("falló el proceso del aviso", { resource: n.resource, error: String(err) })),
  );
  return NextResponse.json({ ok: true });
}
