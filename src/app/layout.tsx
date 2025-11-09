// src/app/layout.tsx
import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Staffpy",
  description: "RH simples para restaurantes e PMEs",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body>
        <header className="w-full border-b bg-white">
          <div className="max-w-5xl mx-auto flex items-center gap-4 p-3 text-sm">
            <a href="/dashboard" className="underline">
              Dashboard
            </a>
            <a href="/employees" className="underline">
              Funcionários
            </a>
            <a href="/attendance" className="underline">
              Presenças
            </a>
            <a href="/attendance/history" className="underline">
              Histórico
            </a>
            <a href="/reports" className="underline">
              Relatórios
            </a>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
