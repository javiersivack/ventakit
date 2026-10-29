import { z } from "zod";

// Aviso de Mercado Libre. Solo dice qué recurso cambió; el estado real se lee de la API.
export const notificationSchema = z.object({
  _id: z.string().optional(),
  resource: z.string().startsWith("/"),
  user_id: z.coerce.number(),
  topic: z.string(),
  application_id: z.coerce.number(),
  attempts: z.number().optional(),
  sent: z.string().optional(),
  received: z.string().optional(),
});
export type Notification = z.infer<typeof notificationSchema>;

export type ParseResult =
  | { ok: true; notification: Notification }
  | { ok: false; reason: "invalid_body" | "wrong_application" };

// Los avisos no vienen firmados. Lo que se puede chequear es que sean de nuestra aplicación;
// la defensa real es no confiar en el cuerpo y leer el recurso con el token del vendedor.
export function parseNotification(body: unknown, applicationId: number): ParseResult {
  const parsed = notificationSchema.safeParse(body);
  if (!parsed.success) return { ok: false, reason: "invalid_body" };
  if (parsed.data.application_id !== applicationId) return { ok: false, reason: "wrong_application" };
  return { ok: true, notification: parsed.data };
}

// Mercado Libre manda varios avisos seguidos del mismo recurso. Mientras uno se procesa, los
// demás del mismo vendedor y recurso se juntan en una sola relectura extra al final, así el
// último estado siempre se lee sin pedirlo diez veces.
export class Coalescer {
  private readonly running = new Map<string, { again: boolean; done: Promise<void> }>();

  run(key: string, task: () => Promise<void>): Promise<void> {
    const current = this.running.get(key);
    if (current) {
      current.again = true;
      return current.done;
    }
    const entry = { again: false, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        do {
          entry.again = false;
          await task();
        } while (entry.again);
      } finally {
        this.running.delete(key);
      }
    })();
    this.running.set(key, entry);
    return entry.done;
  }
}

export const notificationKey = (n: Notification) => `${n.user_id}:${n.resource}`;
