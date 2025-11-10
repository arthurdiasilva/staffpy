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

// === Helpers de horário/validação ===
function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
}

// retorna true se candidate sobrepõe qualquer bloco existente (para ao menos 1 dia em comum)
function hasOverlap(
  existing: ScheduleEntry[] | undefined,
  candidate: ScheduleEntry
): boolean {
  if (!existing || existing.length === 0) return false;
  const cStart = hhmmToMinutes(candidate.start);
  const cEnd = hhmmToMinutes(candidate.end);
  // intervalo válido?
  if (!(cEnd > cStart)) return true; // considera inválido (fim <= início) como “conflito”
  for (const blk of existing) {
    // só compara se compartilha ao menos um dia
    const shareDay = blk.days.some((d) => candidate.days.includes(d));
    if (!shareDay) continue;
    const bStart = hhmmToMinutes(blk.start);
    const bEnd = hhmmToMinutes(blk.end);
    // regra de overlap: A.start < B.end && B.start < A.end
    const overlap = cStart < bEnd && bStart < cEnd;
    if (overlap) return true;
  }
  return false;
}

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

  // seleção de horário no CADASTRO (entra direto no funcionário)
  const [selDays, setSelDays] = useState<Weekday[]>([]);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("18:00");
  const toggleDay = (d: Weekday) =>
    setSelDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
    );

  // edição de horários por funcionário já cadastrado (inline por linha)
  const [editingEmpId, setEditingEmpId] = useState<string | null>(null);
  const [editSelDays, setEditSelDays] = useState<Weekday[]>([]);
  const [editStart, setEditStart] = useState("09:00");
  const [editEnd, setEditEnd] = useState("18:00");
  const toggleEditDay = (d: Weekday) =>
    setEditSelDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
    );

  // ===== Modal de edição de DADOS (nome/role/salário) =====
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState("");
  const [editSalary, setEditSalary] = useState<string>("");

  function openEditModal(emp: Employee) {
    setEditId(emp.id ?? null);
    setEditName(emp.name ?? "");
    setEditRole(emp.role ?? "");
    setEditSalary(
      typeof emp.salaryBase === "number" ? String(emp.salaryBase) : ""
    );
    setEditOpen(true);
  }

  function closeEditModal() {
    setEditOpen(false);
    setEditId(null);
    setEditName("");
    setEditRole("");
    setEditSalary("");
  }

  async function saveEditModal() {
    if (!user || !editId) return;

    const salary =
      editSalary.trim() === ""
        ? undefined
        : Number(editSalary.replace(",", "."));
    if (editSalary && Number.isNaN(salary)) {
      alert("Salário inválido");
      return;
    }

    try {
      await updateDoc(doc(db, "employees", editId), {
        name: editName.trim(),
        role: editRole.trim(),
        salaryBase: salary,
      });

      // refresh leve da lista
      setList((prev) =>
        prev
          .map((p) =>
            p.id === editId
              ? {
                  ...p,
                  name: editName.trim(),
                  role: editRole.trim(),
                  salaryBase: salary,
                }
              : p
          )
          .sort((a, b) => a.name.localeCompare(b.name))
      );

      closeEditModal();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Erro ao salvar edição");
    }
  }

  // util: busca sem acentos/maiúsculas
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

  const [search, setSearch] = useState("");
  const filteredList = useMemo(
    () => list.filter((e) => normalize(e.name).includes(normalize(search))),
    [list, search]
  );
  // ordem por nome
  const [nameAsc, setNameAsc] = useState(true);
  // aplica ordenação sobre o filtrado
  const viewList = useMemo(
    () =>
      [...filteredList].sort((a, b) =>
        nameAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
      ),
    [filteredList, nameAsc]
  );

  // paginação
  const [pageSize, setPageSize] = useState(10); // 10/20/50
  const [page, setPage] = useState(1);

  const total = viewList.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const pagedList = useMemo(() => {
    const start = (page - 1) * pageSize;
    return viewList.slice(start, start + pageSize);
  }, [viewList, page, pageSize]);

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

  // adicionar (cadastro)
  const handleAdd = async (ev: React.FormEvent) => {
    ev.preventDefault();
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
      // valida fim > início
      if (!(hhmmToMinutes(end) > hhmmToMinutes(start))) {
        setErr("Horário inválido: a hora 'Até' deve ser maior que 'De'.");
        return;
      }
      const candidate: ScheduleEntry = { days: [...selDays], start, end };

      scheduleToSave.push(candidate);
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

      // refresh (leve)
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

      // refresh leve em memória
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
    // valida fim > início
    if (!(hhmmToMinutes(editEnd) > hhmmToMinutes(editStart))) {
      alert("Horário inválido: a hora 'Até' deve ser maior que 'De'.");
      return;
    }

    const candidate: ScheduleEntry = {
      days: [...editSelDays],
      start: editStart,
      end: editEnd,
    };

    const isDuplicate = (emp.schedule ?? []).some(
      (b) =>
        b.start === candidate.start &&
        b.end === candidate.end &&
        b.days.length === candidate.days.length &&
        b.days.every((d) => candidate.days.includes(d))
    );
    if (isDuplicate) {
      alert("Este bloco já existe para este funcionário.");
      return;
    }

    // verifica sobreposição com a agenda atual do funcionário
    const existsOverlap = hasOverlap(emp.schedule, candidate);
    if (existsOverlap) {
      alert(
        "Conflito de horário: este bloco se sobrepõe a outro já existente em pelo menos um dos dias selecionados."
      );
      return;
    }

    try {
      const ref = doc(db, "employees", emp.id);
      const next = [...(emp.schedule ?? []), candidate];
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
          <div className="mt-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nome..."
              className="w-full md:w-80 rounded-lg border px-3 py-2 text-sm"
            />
          </div>

          {/* MODAL DE EDIÇÃO DE DADOS */}
          {editOpen && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
              <div className="bg-white rounded-xl shadow p-4 w-full max-w-md">
                <h3 className="text-lg font-medium mb-3">Editar funcionário</h3>

                <div className="grid gap-3">
                  <input
                    className="rounded-lg border px-3 py-2"
                    placeholder="Nome"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                  <input
                    className="rounded-lg border px-3 py-2"
                    placeholder="Função"
                    value={editRole}
                    onChange={(e) => setEditRole(e.target.value)}
                  />
                  <input
                    className="rounded-lg border px-3 py-2"
                    placeholder="Salário base (opcional)"
                    inputMode="decimal"
                    value={editSalary}
                    onChange={(e) => setEditSalary(e.target.value)}
                  />
                </div>

                <div className="mt-4 flex gap-2 justify-end">
                  <button
                    onClick={closeEditModal}
                    className="rounded-md border px-3 py-1"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={saveEditModal}
                    className="rounded-md bg-black text-white px-3 py-1"
                  >
                    Salvar
                  </button>
                </div>
              </div>
            </div>
          )}
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
              <div className="mb-3 flex flex-col md:flex-row md:items-center gap-2 text-sm">
                <div>
                  Mostrando{" "}
                  <strong>
                    {Math.min((page - 1) * pageSize + 1, total)}–
                    {Math.min(page * pageSize, total)}
                  </strong>{" "}
                  de <strong>{total}</strong>
                </div>

                <div className="md:ml-auto flex items-center gap-2">
                  <label>Por página:</label>
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setPage(1);
                    }}
                    className="rounded-md border px-2 py-1"
                  >
                    <option value={10}>10</option>
                    <option value={20}>20</option>
                    <option value={50}>50</option>
                  </select>

                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className={`rounded-md border px-2 py-1 ${
                      page <= 1 ? "opacity-50 cursor-not-allowed" : ""
                    }`}
                    title="Anterior"
                  >
                    ←
                  </button>

                  <span>
                    pág. <strong>{page}</strong> / {totalPages}
                  </span>

                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className={`rounded-md border px-2 py-1 ${
                      page >= totalPages ? "opacity-50 cursor-not-allowed" : ""
                    }`}
                    title="Próxima"
                  >
                    →
                  </button>
                </div>
              </div>

              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-2 pr-3">
                      <button
                        type="button"
                        onClick={() => setNameAsc((v) => !v)}
                        className="inline-flex items-center gap-1 underline"
                        title="Ordenar por nome"
                      >
                        Nome {nameAsc ? "▲" : "▼"}
                      </button>
                    </th>
                    <th className="py-2 pr-3">Função</th>
                    <th className="py-2 pr-3">Salário</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Horários</th>
                    <th className="py-2 pr-3">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedList.map((e) => (
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
                                  {blk.days
                                    .map((d) => WEEKDAY_LABEL[d])
                                    .join(", ")}
                                </span>{" "}
                                — {blk.start} às {blk.end}{" "}
                                <button
                                  type="button"
                                  onClick={() =>
                                    removeBlockFromEmployee(e, idx)
                                  }
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
                            <div className="text-xs mb-2">
                              Adicionar novo bloco
                            </div>
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
                                  onChange={(ev) =>
                                    setEditStart(ev.target.value)
                                  }
                                  className="ml-2 border rounded px-2 py-1 text-xs"
                                />
                              </label>
                              <label className="text-xs">
                                Até:
                                <input
                                  type="time"
                                  value={editEnd}
                                  onChange={(ev) => setEditEnd(ev.target.value)}
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
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => toggleActive(e.id, e.active)}
                            className="rounded-md border px-2 py-1"
                          >
                            {e.active ? "Desativar" : "Ativar"}
                          </button>

                          <button
                            onClick={() =>
                              setEditingEmpId((curr) =>
                                curr === e.id ? null : e.id ?? null
                              )
                            }
                            className="rounded-md border px-2 py-1"
                            title="Editar horários"
                          >
                            {editingEmpId === e.id
                              ? "Fechar editor"
                              : "Editar horários"}
                          </button>

                          <button
                            onClick={() => openEditModal(e)}
                            className="rounded-md border px-2 py-1"
                            title="Editar dados"
                          >
                            Editar dados
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
