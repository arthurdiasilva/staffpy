// src/app/dashboard/page.tsx
"use client";

import { useEffect, useState } from "react";
import { auth } from "@/lib/firebase";
import { onAuthStateChanged, signOut, User } from "firebase/auth";
import { useRouter } from "next/navigation";

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setReady(true);
      if (!u) router.replace("/login");
    });
    return () => unsub();
  }, [router]);

  if (!ready)
    return (
      <div className="min-h-screen flex items-center justify-center">
        Carregando…
      </div>
    );
  if (!user) return null;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-3xl mx-auto">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Staffpy — Dashboard</h1>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">{user.email}</span>
            <button
              onClick={() => signOut(auth)}
              className="rounded-lg bg-black text-white px-3 py-1.5 text-sm"
            >
              Sair
            </button>
          </div>
        </header>

        <main className="mt-6">
          <p className="text-gray-700">
            Login ok! Próximo passo será criar /employees.
          </p>
        </main>
      </div>
    </div>
  );
}
