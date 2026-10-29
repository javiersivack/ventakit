import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "VentaKit — API de Mercado Libre para Next.js",
  description: "Conexión de vendedores que no se corta y avisos de Mercado Libre a prueba de duplicados y desorden.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "48px auto", padding: "0 16px" }}>
        {children}
      </body>
    </html>
  );
}
