export default async function Home({ searchParams }: { searchParams: Promise<{ connected?: string }> }) {
  const { connected } = await searchParams;
  return (
    <main>
      <h1>VentaKit</h1>
      <p>Ejemplo mínimo: conectá una cuenta vendedora y las órdenes nuevas se guardan solas.</p>
      {connected ? <p>Cuenta {connected} conectada.</p> : <a href="/api/meli/connect">Conectar cuenta de Mercado Libre</a>}
    </main>
  );
}
