// src/app/employees/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { auth, db } from "../../lib/firebase";
import { onAuthStateChanged, User } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  updateDoc,
  where,
} from "firebase/firestore";

type Employee = {
  id?: string;
  ownerId: string;
  name: string;
  role: string;
  salaryBase?: number;
  workDays?: string[];
  active: boolean;
  createdAt: number;
};

export default function EmployeesPage() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  // lista
  const [list, setList] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const employeesCol = useMemo(() => collection(db, "employees"), []);

  // form
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [salaryBase, setSalaryBase] = useState("");
  const [workDaysStr, setWorkDaysStr] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // autenticação
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setReady(true);
    });
    return () => unsub();
  }, []);

  // carregar funcionários
  useEffect(() => {
    if (!user) return;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const q = query(employeesCol, where("ownerId", "==", user.uid));
        const snap = await getDocs(q);
        const data: Employee[] = [];
        snap.forEach((d) => {
          const v = d.data() as Omit<Employee, "id">;
          data.push({ id: d.id, ...v });
        });
        data.sort((a, b) => a.name.localeCompare(b.name));
        setList(data);
      } catch (e) {
        const msg =
          e instanceof Error ? e.message : "Erro ao carregar funcionários";
        setErr(msg);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, employeesCol]);

  // adicionar
  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    const days = workDaysStr
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);

    const salary = salaryBase
      ? Number(salaryBase.replace(",", "."))
      : undefined;
    if (salaryBase && Number.isNaN(salary)) {
      setErr("Salário inválido");
      return;
    }

    const newEmp: Employee = {
      ownerId: user.uid,
      name: name.trim(),
      role: role.trim(),
      salaryBase: salary,
      workDays: days.length ? days : undefined,
      active: true,
      createdAt: Date.now(),
    };

    setSaving(true);
    setErr(null);
    try {
      await addDoc(employeesCol, { ...newEmp });

      setName("");
      setRole("");
      setSalaryBase("");
      setWorkDaysStr("");

      // refresh
      const q = query(employeesCol, where("ownerId", "==", user.uid));
      const snap = await getDocs(q);
      const data: Employee[] = [];
      snap.forEach((d) => {
        const v = d.data() as Omit<Employee, "id">;
        data.push({ id: d.id, ...v });
      });
      data.sort((a, b) => a.name.localeCompare(b.name));
      setList(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erro ao salvar funcionário";
      setErr(msg);
    } finally {
      setSaving(false);
    }
  };

  // ativar/desativar
  const toggleActive = async (id?: string, current?: boolean) => {
    if (!id || !user) return;
    try {
      await updateDoc(doc(db, "employees", id), { active: !current });

      const q = query(employeesCol, where("ownerId", "==", user.uid));
      const snap = await getDocs(q);
      const data: Employee[] = [];
      snap.forEach((d) => {
        const v = d.data() as Omit<Employee, "id">;
        data.push({ id: d.id, ...v });
      });
      data.sort((a, b) => a.name.localeCompare(b.name));
      setList(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erro ao atualizar";
      setErr(msg);
    }
  };

  // remover
  const removeEmp = async (id?: string) => {
    if (!id || !user) return;
    if (!confirm("Remover este funcionário?")) return;
    try {
      await deleteDoc(doc(db, "employees", id));

      const q = query(employeesCol, where("ownerId", "==", user.uid));
      const snap = await getDocs(q);
      const data: Employee[] = [];
      snap.forEach((d) => {
        const v = d.data() as Omit<Employee, "id">;
        data.push({ id: d.id, ...v });
      });
      data.sort((a, b) => a.name.localeCompare(b.name));
      setList(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erro ao remover";
      setErr(msg);
    }
  };

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p>Carregando…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <a className="underline" href="/login">
          Ir para login
        </a>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-5xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold">Funcionários</h1>
          <p className="text-sm text-gray-600">
            Cadastre e gerencie sua equipe.
          </p>
        </header>

        <div className="bg-white rounded-xl shadow p-4 mb-6">
          <h2 className="font-medium mb-3">Adicionar funcionário</h2>
          <form
            onSubmit={handleAdd}
            className="grid grid-cols-1 md:grid-cols-4 gap-3"
          >
            <input
              className="rounded-lg border px-3 py-2"
              placeholder="Nome"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <input
              className="rounded-lg border px-3 py-2"
              placeholder="Função (ex.: garçom)"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              required
            />
            <input
              className="rounded-lg border px-3 py-2"
              placeholder="Salário base (opcional)"
              value={salaryBase}
              onChange={(e) => setSalaryBase(e.target.value)}
              inputMode="decimal"
            />
            <input
              className="rounded-lg border px-3 py-2 md:col-span-2"
              placeholder="Dias (ex.: seg, ter, qua)"
              value={workDaysStr}
              onChange={(e) => setWorkDaysStr(e.target.value)}
            />
            <button
              disabled={saving}
              className="rounded-lg bg-black text-white px-4 py-2 md:col-span-2"
            >
              {saving ? "Salvando..." : "Adicionar"}
            </button>
          </form>
          {err && <p className="text-sm text-red-600 mt-2">{err}</p>}
        </div>

        <div className="bg-white rounded-xl shadow p-4">
          <h2 className="font-medium mb-3">Equipe cadastrada</h2>
          {loading ? (
            <p>Carregando…</p>
          ) : list.length === 0 ? (
            <p className="text-sm text-gray-600">
              Nenhum funcionário cadastrado ainda.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-2 pr-3">Nome</th>
                    <th className="py-2 pr-3">Função</th>
                    <th className="py-2 pr-3">Dias</th>
                    <th className="py-2 pr-3">Salário</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((e) => (
                    <tr key={e.id} className="border-b last:border-0">
                      <td className="py-2 pr-3">{e.name}</td>
                      <td className="py-2 pr-3">{e.role}</td>
                      <td className="py-2 pr-3">
                        {e.workDays?.length ? e.workDays.join(", ") : "-"}
                      </td>
                      <td className="py-2 pr-3">
                        {typeof e.salaryBase === "number"
                          ? `R$ ${e.salaryBase.toFixed(2)}`
                          : "-"}
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={`px-2 py-1 rounded-full text-xs ${
                            e.active
                              ? "bg-green-100 text-green-700"
                              : "bg-gray-200 text-gray-700"
                          }`}
                        >
                          {e.active ? "Ativo" : "Inativo"}
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex gap-2">
                          <button
                            onClick={() => toggleActive(e.id, e.active)}
                            className="rounded-md border px-2 py-1"
                          >
                            {e.active ? "Desativar" : "Ativar"}
                          </button>
                          <button
                            onClick={() => removeEmp(e.id)}
                            className="rounded-md border px-2 py-1 text-red-600"
                          >
                            Remover
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
