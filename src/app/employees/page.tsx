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

import {
  WEEKDAY_LABEL,
  type Employee,
  type ScheduleEntry,
  type Weekday,
} from "../../types";

const DAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6]; // Dom..Sáb

export default function EmployeesPage() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  // lista
  const [list, setList] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const employeesCol = useMemo(() => collection(db, "employees"), []);

  // form (cadastro)
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [salaryBase, setSalaryBase] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // seleção de horário no CADASTRO (sem precisar "adicionar bloco")
  const [selDays, setSelDays] = useState<Weekday[]>([]);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("18:00");
  const toggleDay = (d: Weekday) =>
    setSelDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
    );

  // edição de horários por funcionário já cadastrado
  const [editingEmpId, setEditingEmpId] = useState<string | null>(null);
  const [editSelDays, setEditSelDays] = useState<Weekday[]>([]);
  const [editStart, setEditStart] = useState("09:00");
  const [editEnd, setEditEnd] = useState("18:00");
  const toggleEditDay = (d: Weekday) =>
    setEditSelDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
    );

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

    const salary = salaryBase
      ? Number(salaryBase.replace(",", "."))
      : undefined;
    if (salaryBase && Number.isNaN(salary)) {
      setErr("Salário inválido");
      return;
    }

    // monta schedule automaticamente com o que estiver selecionado
    const scheduleToSave: ScheduleEntry[] = [];
    if (selDays.length > 0) {
      scheduleToSave.push({ days: [...selDays], start, end });
    }

    const newEmp: Employee = {
      ownerId: user.uid,
      name: name.trim(),
      role: role.trim(),
      salaryBase: salary,
      active: true,
      createdAt: Date.now(),
      schedule: scheduleToSave.length ? scheduleToSave : undefined,
    };

    setSaving(true);
    setErr(null);
    try {
      await addDoc(employeesCol, { ...newEmp });

      // reset form
      setName("");
      setRole("");
      setSalaryBase("");
      setSelDays([]);
      setStart("09:00");
      setEnd("18:00");

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

      // refresh leve
      setList((prev) =>
        prev.map((p) => (p.id === id ? { ...p, active: !current } : p))
      );
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
      setList((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erro ao remover";
      setErr(msg);
    }
  };

  // ==== EDIÇÃO DE HORÁRIOS (por funcionário) ====
  const openEdit = (emp: Employee) => {
    setEditingEmpId((curr) => (curr === emp.id ? null : emp.id ?? null));
    // reset form de edição
    setEditSelDays([]);
    setEditStart("09:00");
    setEditEnd("18:00");
  };

  const addBlockToEmployee = async (emp: Employee) => {
    if (!emp.id) return;
    if (editSelDays.length === 0) {
      alert("Escolha pelo menos um dia.");
      return;
    }
    if (!editStart || !editEnd) {
      alert("Informe horários de início e fim.");
      return;
    }
    const newBlock: ScheduleEntry = {
      days: [...editSelDays],
      start: editStart,
      end: editEnd,
    };
    try {
      const ref = doc(db, "employees", emp.id);
      const next = [...(emp.schedule ?? []), newBlock];
      await updateDoc(ref, { schedule: next });
      // atualiza UI
      setList((prev) =>
        prev.map((p) => (p.id === emp.id ? { ...p, schedule: next } : p))
      );
      // limpa mini-form
      setEditSelDays([]);
      setEditStart("09:00");
      setEditEnd("18:00");
    } catch (e) {
      alert(e instanceof Error ? e.message : "Erro ao salvar horário");
    }
  };

  const removeBlockFromEmployee = async (emp: Employee, idx: number) => {
    if (!emp.id) return;
    const curr = emp.schedule ?? [];
    const next = curr.filter((_, i) => i !== idx);
    try {
      const ref = doc(db, "employees", emp.id);
      await updateDoc(ref, { schedule: next.length ? next : null });
      setList((prev) =>
        prev.map((p) => (p.id === emp.id ? { ...p, schedule: next } : p))
      );
    } catch (e) {
      alert(e instanceof Error ? e.message : "Erro ao remover horário");
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
          {err && <p className="text-sm text-red-600 mt-2">{err}</p>}
        </header>

        {/* ===== FORM DE CADASTRO ===== */}
        <div className="bg-white rounded-xl shadow p-4 mb-6">
          <h2 className="font-medium mb-3">Adicionar funcionário</h2>
          <form onSubmit={handleAdd} className="grid grid-cols-1 gap-3">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
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
            </div>

            {/* Seleção de 1 bloco que entra direto no cadastro */}
            <div className="rounded-lg border p-3 bg-gray-50">
              <div className="text-sm font-medium mb-2">
                Horário de trabalho (opcional) — o que você marcar aqui já será
                salvo com o funcionário.
              </div>

              <div className="text-xs mb-2">Escolha os dias</div>
              <div className="flex flex-wrap gap-2 mb-3">
                {DAYS.map((d) => (
                  <label
                    key={d}
                    className={`px-2 py-1 rounded border text-xs cursor-pointer ${
                      selDays.includes(d)
                        ? "bg-blue-100 border-blue-300"
                        : "bg-white"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mr-1"
                      checked={selDays.includes(d)}
                      onChange={() => toggleDay(d)}
                    />
                    {WEEKDAY_LABEL[d]}
                  </label>
                ))}
              </div>

              <div className="flex items-center gap-3">
                <label className="text-xs">
                  De:
                  <input
                    type="time"
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                    className="ml-2 border rounded px-2 py-1 text-xs"
                  />
                </label>
                <label className="text-xs">
                  Até:
                  <input
                    type="time"
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                    className="ml-2 border rounded px-2 py-1 text-xs"
                  />
                </label>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                disabled={saving}
                className="rounded-lg bg-black text-white px-4 py-2"
              >
                {saving ? "Salvando..." : "Adicionar funcionário"}
              </button>
            </div>
          </form>
        </div>

        {/* ===== LISTA ===== */}
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
                    <th className="py-2 pr-3">Salário</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Horários</th>
                    <th className="py-2 pr-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((e) => (
                    <tr key={e.id} className="border-b last:border-0 align-top">
                      <td className="py-2 pr-3">{e.name}</td>
                      <td className="py-2 pr-3">{e.role}</td>
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
                        {e.schedule?.length ? (
                          <ul className="space-y-1">
                            {e.schedule.map((blk, idx) => (
                              <li key={idx} className="text-xs">
                                <span className="font-medium">
                                  {blk.days.map((d) => WEEKDAY_LABEL[d]).join(", ")}
                                </span>{" "}
                                — {blk.start} às {blk.end}{" "}
                                <button
                                  type="button"
                                  onClick={() => removeBlockFromEmployee(e, idx)}
                                  className="ml-2 text-red-600 underline"
                                  title="Remover este bloco"
                                >
                                  remover
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="text-xs text-gray-500">
                            Sem horários definidos
                          </span>
                        )}

                        {/* Editor inline para adicionar novos blocos depois */}
                        {editingEmpId === e.id && (
                          <div className="mt-3 rounded-lg border p-3 bg-gray-50">
                            <div className="text-xs mb-2">Adicionar novo bloco</div>
                            <div className="flex flex-wrap gap-2 mb-3">
                              {DAYS.map((d) => (
                                <label
                                  key={d}
                                  className={`px-2 py-1 rounded border text-xs cursor-pointer ${
                                    editSelDays.includes(d)
                                      ? "bg-blue-100 border-blue-300"
                                      : "bg-white"
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    className="mr-1"
                                    checked={editSelDays.includes(d)}
                                    onChange={() => toggleEditDay(d)}
                                  />
                                  {WEEKDAY_LABEL[d]}
                                </label>
                              ))}
                            </div>
                            <div className="flex items-center gap-3 mb-3">
                              <label className="text-xs">
                                De:
                                <input
                                  type="time"
                                  value={editStart}
                                  onChange={(e2) => setEditStart(e2.target.value)}
                                  className="ml-2 border rounded px-2 py-1 text-xs"
                                />
                              </label>
                              <label className="text-xs">
                                Até:
                                <input
                                  type="time"
                                  value={editEnd}
                                  onChange={(e2) => setEditEnd(e2.target.value)}
                                  className="ml-2 border rounded px-2 py-1 text-xs"
                                />
                              </label>
                            </div>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => addBlockToEmployee(e)}
                                className="rounded-md border px-3 py-1 text-xs bg-blue-600 text-white"
                              >
                                Salvar bloco
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingEmpId(null)}
                                className="rounded-md border px-3 py-1 text-xs"
                              >
                                Fechar
                              </button>
                            </div>
                          </div>
                        )}
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
                            onClick={() => openEdit(e)}
                            className="rounded-md border px-2 py-1"
                          >
                            {editingEmpId === e.id
                              ? "Fechar editor"
                              : "Editar horários"}
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