# VentaKit: la API de Mercado Libre en Next.js, sin cuentas desconectadas ni órdenes perdidas

Starter de Next.js + TypeScript para apps que trabajan con cuentas de vendedores de Mercado
Libre: conexión por OAuth que no se corta, avisos (notificaciones) a prueba de duplicados y
desorden, y órdenes que siempre quedan en su último estado.

> Proyecto independiente. No está afiliado ni avalado por Mercado Libre.

## Qué problemas resuelve

| Problema típico | Qué hace VentaKit |
| --- | --- |
| El access token vence a las 6 h y la integración se cae de noche | Se renueva solo, con 1 h de margen, antes de cada pedido. |
| El refresh token es de un solo uso: dos renovaciones a la vez desconectan al vendedor (`invalid_grant`) | Una sola renovación en curso por vendedor; los demás pedidos la esperan. |
| Un `invalid_grant` hace reintentar para siempre | La cuenta queda marcada para volver a conectar y no se insiste. |
| Un 401 en medio de un pedido | Renueva el token una vez y repite el pedido. |
| `429` o errores 5xx de la API | Reintenta con backoff y respeta `Retry-After`. |
| Los avisos no vienen firmados | Se valida `application_id` y nunca se confía en el aviso: la orden se lee de la API con el token del vendedor y se verifica que sea suya. |
| Si tu endpoint tarda, Mercado Libre reintenta y puede dejar de mandarte avisos | Responde 200 enseguida y procesa después (`after()` de Next.js). |
| Diez avisos seguidos de la misma orden | Se juntan: una lectura en curso y, como mucho, una relectura al final. |
| Una lectura vieja que termina después de una nueva | La orden se guarda solo si `last_updated` es más nuevo. |
| El mail de "venta nueva" sale dos veces | `onOrderPaid` se llama una sola vez, cuando la orden pasa a `paid`. |
| Login sin protección contra CSRF | OAuth con `state` y PKCE (S256) en cookies httpOnly. |

La lógica de cada fila tiene tests (`npm test`); las rutas de `app/api` son el pegamento.

## Puesta en marcha

1. Creá una aplicación en el DevCenter de Mercado Libre de tu país. Redirect URI:
   `https://tu-dominio.com/api/meli/callback`. URL de notificaciones:
   `https://tu-dominio.com/api/meli/notifications`, con el tópico `orders_v2`.
2. Configurá e iniciá:

```bash
npm install
cp .env.example .env.local   # MELI_CLIENT_ID, MELI_CLIENT_SECRET, MELI_REDIRECT_URI, MELI_SITE_ID
npm run dev
```

3. Entrá a la home y tocá "Conectar cuenta de Mercado Libre". Mercado Libre exige https en la
   Redirect URI: para probar en local usá un túnel (por ejemplo `cloudflared` o `ngrok`).

## Estructura

| Archivo | Qué hace |
| --- | --- |
| `lib/meli/oauth.ts` | URL de autorización por país, PKCE, canje de code y renovación |
| `lib/meli/tokens.ts` | `TokenManager`: renovación anticipada, una sola a la vez, `invalid_grant` |
| `lib/meli/client.ts` | Cliente por vendedor: reintentos, 401 → renovar y repetir |
| `lib/meli/notifications.ts` | Validación de avisos y `Coalescer` |
| `lib/orders.ts` | `OrderStore` con guardado solo-si-es-más-nuevo |
| `lib/process.ts` | Procesa un aviso de `orders_v2` de punta a punta |
| `app/api/meli/*` | Rutas: `connect`, `callback`, `notifications` |

## En producción

Los stores de ejemplo guardan en memoria, así que se pierden al reiniciar. Implementá
`TokenStore` y `OrderStore` sobre tu base:

- **`OrderStore.upsertIfNewer`:** con la fila bloqueada (`SELECT ... FOR UPDATE`), guardá solo si
  `last_updated` es más nuevo, o igual pero con otro estado (`last_updated` viene en segundos y
  dos cambios pueden caer en el mismo). La versión Pro trae este store para Postgres.
- **`TokenStore`:** con más de una instancia, la renovación tiene que tomar un lock por
  vendedor en la base (`SELECT ... FOR UPDATE` o un advisory lock). El `TokenManager` evita
  dos renovaciones dentro del mismo proceso, no entre procesos.
- **Avisos perdidos:** si tu servidor estuvo caído o un proceso falló, la orden queda vieja
  hasta el próximo aviso. Conviene un cron que relea las órdenes que cambiaron hace poco
  (`GET /orders/search?seller=...&order.date_last_updated.from=...`) con `processNotification`.
  La versión Pro trae esa conciliación (`/api/cron/reconcile`).

## Quién lo hizo

Javier Sivack, ingeniero backend (pagos, sistemas bancarios, integraciones de APIs). Está hecho
con Claude, una IA, como compañero de programación: yo lo dirijo, lo pruebo contra la API real de
Mercado Libre y respondo por él. Cada caso tiene su test; si encontrás un error, abrí un issue.

¿Necesitás una integración a medida? https://javiersivack.com/es#contact

## Licencia

MIT. Ver `LICENSE`.
