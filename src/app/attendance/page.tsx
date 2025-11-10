// src/app/attendance/page.tsx
"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { auth, db } from "../../lib/firebase";
import { onAuthStateChanged, User } from "firebase/auth";
import {
  collection,
  doc,
  getDocs,
  getDoc,
  query,
  setDoc,
  updateDoc,
  where,
  deleteField,
} from "firebase/firestore";
import type { Employee, Weekday } from "../../types";

// ===== Tipos locais =====
type Attendance = {
  id?: string;
  ownerId: string;
  employeeId: string;
  employeeName: string;
  date: string; // "YYYY-MM-DD"
  checkIn?: number;
  checkOut?: number;
  status: "pending" | "present" | "left";
};

// ===== Utilidades =====
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function statusOf(att?: { status?: "pending" | "present" | "left" }) {
  return (att?.status ?? "pending") as "pending" | "present" | "left";
}

function msToHMM(ms: number) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

// conta ao vivo e lida com out < in
function workedToday(att?: Attendance, nowMs?: number) {
  if (!att?.checkIn) return "-";
  const now = nowMs ?? Date.now();
  const endCandidate = att.checkOut ?? now;
  const end = endCandidate < att.checkIn ? now : endCandidate;
  const ms = end - att.checkIn;
  if (ms <= 0) return "0h 0m";
  return msToHMM(ms);
}

function getTodayWeekday(): Weekday {
  // 0=Dom, 1=Seg, ..., 6=Sáb
  return new Date().getDay() as Weekday;
}

// transforma "HH:MM" no timestamp em ms do mesmo dia local
function timeStrToTodayMs(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

// dado o schedule do funcionário, retorna blocos que valem HOJE
function getTodayBlocks(emp?: Employee) {
  if (!emp?.schedule?.length)
    return [] as Array<{
      startMs: number;
      endMs: number;
      start: string;
      end: string;
    }>;
  const wd = getTodayWeekday();
  const list: Array<{
    startMs: number;
    endMs: number;
    start: string;
    end: string;
  }> = [];
  for (const blk of emp.schedule) {
    if (blk.days?.includes(wd)) {
      const sMs = timeStrToTodayMs(blk.start);
      const eMs = timeStrToTodayMs(blk.end);
      if (!Number.isNaN(sMs) && !Number.isNaN(eMs) && eMs > sMs) {
        list.push({ startMs: sMs, endMs: eMs, start: blk.start, end: blk.end });
      }
    }
  }
  list.sort((a, b) => a.startMs - b.startMs);
  return list;
}

function plannedMinutesToday(emp?: Employee) {
  const blocks = getTodayBlocks(emp);
  let total = 0;
  for (const b of blocks) total += Math.max(0, b.endMs - b.startMs);
  return Math.floor(total / 60000);
}

function plannedLabelToday(emp?: Employee) {
  const blocks = getTodayBlocks(emp);
  if (!blocks.length) return "-";
  return blocks.map((b) => `${b.start}–${b.end}`).join("; ");
}

function workedMinutes(
  att?: { checkIn?: number; checkOut?: number },
  nowMs?: number
) {
  if (!att?.checkIn) return 0;
  const end = att.checkOut ?? nowMs ?? Date.now();
  const ms = Math.max(0, end - att.checkIn);
  return Math.floor(ms / 60000);
}

function complianceBadge(
  att: { checkIn?: number; checkOut?: number } | undefined,
  emp: Employee | undefined,
  nowMs?: number
) {
  const planned = plannedMinutesToday(emp);
  if (!planned) return { text: "—", cls: "bg-gray-100 text-gray-700" };

  const worked = workedMinutes(att, nowMs);
  if (!att?.checkIn)
    return { text: "aguardando", cls: "bg-yellow-100 text-yellow-800" };

  if (!att?.checkOut) {
    if (worked >= planned)
      return {
        text: "cumpriu (em andamento)",
        cls: "bg-green-100 text-green-700",
      };
    return { text: "em andamento", cls: "bg-blue-100 text-blue-700" };
  }

  if (worked >= planned)
    return { text: "cumpriu", cls: "bg-green-100 text-green-700" };
  return { text: "incompleto", cls: "bg-red-100 text-red-700" };
}

export default function AttendancePage() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [attMap, setAttMap] = useState<Record<string, Attendance | undefined>>(
    {}
  );
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // toasts
  type Toast = { id: number; kind: "success" | "error" | "info"; text: string };
  const [toasts, setToasts] = useState<Toast[]>([]);
  const pushToast = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((arr) => [...arr, { id, ...t }]);
    setTimeout(() => {
      setToasts((arr) => arr.filter((x) => x.id !== id));
    }, 2500);
  }, []);

  // relógio: re-render a cada 5s
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  // normaliza para busca sem acentos/maiúsculas
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

  // busca
  const [search, setSearch] = useState("");
  const filteredEmployees = useMemo(
    () =>
      employees.filter((e) => normalize(e.name).includes(normalize(search))),
    [employees, search]
  );

  // filtro por status
  const [statusFilter, setStatusFilter] = useState<
    "all" | "present" | "left" | "pending"
  >("all");

  // ordenação
  const [nameAsc, setNameAsc] = useState(true);

  // aplica filtro + ordenação
  const viewEmployees = useMemo(
    () =>
      [...filteredEmployees]
        .filter((e) => {
          if (statusFilter === "all") return true;
          const att = attMap[String(e.id)];
          return statusOf(att) === statusFilter;
        })
        .sort((a, b) =>
          nameAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
        ),
    [filteredEmployees, nameAsc, statusFilter, attMap]
  );

  // apenas funcionários com id definido (evita erro de indexação)
  const safeEmployees = useMemo(
    () => viewEmployees.filter((e): e is Employee & { id: string } => !!e.id),
    [viewEmployees]
  );

  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const total = safeEmployees.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // se mudar filtro/busca/tamanho, volta para página 1
  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, pageSize]);

  // se a página atual ficar maior que o total (depois de filtros), corrige
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pagedEmployees = useMemo(() => {
    const start = (page - 1) * pageSize;
    return safeEmployees.slice(start, start + pageSize);
  }, [safeEmployees, page, pageSize]);

  const employeesCol = useMemo(() => collection(db, "employees"), []);

  // autenticação
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setReady(true);
      if (!u) window.location.href = "/login";
    });
    return () => unsub();
  }, []);

  // carregar equipe + presenças do dia
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setErr(null);
      try {
        // 1) funcionários ativos
        const qEmp = query(
          employeesCol,
          where("ownerId", "==", user.uid),
          where("active", "==", true)
        );
        const snapEmp = await getDocs(qEmp);

        const emps: Employee[] = [];
        snapEmp.forEach((d) => {
          const v = d.data() as Omit<Employee, "id">;
          emps.push({ id: d.id, ...v });
        });
        emps.sort((a, b) => a.name.localeCompare(b.name));
        if (!cancelled) setEmployees(emps);

        // 2) presenças do dia (1 doc por funcionário/dia)
        const date = todayStr();
        const map: Record<string, Attendance | undefined> = {};

        for (const e of emps) {
          if (!e.id) continue;
          const docId = `${user.uid}__${e.id}__${date}`;
          const attRef = doc(db, "attendance", docId);
          const attSnap = await getDoc(attRef);
          map[e.id] = attSnap.exists()
            ? ({
                id: attSnap.id,
                ...(attSnap.data() as Attendance),
              } as Attendance)
            : undefined;
        }

        if (!cancelled) setAttMap(map);
      } catch (e) {
        const message =
          e instanceof Error ? e.message : "Erro ao carregar presenças";
        if (!cancelled) {
          setErr(message);
          pushToast({ kind: "error", text: message });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, employeesCol, pushToast]);

  // ações
  const handleCheckIn = async (emp: Employee) => {
    if (!user || !emp.id) return;
    const date = todayStr();
    const id = `${user.uid}__${emp.id}__${date}`;
    const ref = doc(db, "attendance", id);

    try {
      const nowVal = Date.now();
      const existing = attMap[emp.id];

      if (!existing) {
        const newAtt: Attendance = {
          ownerId: user.uid,
          employeeId: emp.id,
          employeeName: emp.name,
          date,
          checkIn: nowVal,
          status: "present",
        };
        await setDoc(ref, newAtt);
        setAttMap((m) => ({ ...m, [emp.id!]: { id, ...newAtt } }));
      } else {
        // novo turno: zera a saída anterior
        await updateDoc(ref, {
          checkIn: nowVal,
          status: "present",
          checkOut: deleteField(),
        });
        setAttMap((m) => ({
          ...m,
          [emp.id!]: { ...existing, checkOut: nowVal, status: "left" },
        }));
      }

      setNow(Date.now());
      pushToast({
        kind: "success",
        text: `Entrada registrada para ${emp.name}`,
      });
    } catch (e) {
      pushToast({
        kind: "error",
        text: e instanceof Error ? e.message : "Erro no check-in",
      });
    }
  };

  const handleCheckOut = async (emp: Employee) => {
    if (!user || !emp.id) return;
    const date = todayStr();
    const id = `${user.uid}__${emp.id}__${date}`;
    const ref = doc(db, "attendance", id);

    try {
      const existing = attMap[emp.id];

      if (!existing?.checkIn) {
        pushToast({
          kind: "info",
          text: "Primeiro registre a Entrada deste funcionário.",
        });
        return;
      }
      if (existing.checkOut) {
        pushToast({
          kind: "info",
          text: "Este funcionário já finalizou o turno hoje.",
        });
        return;
      }

      const nowVal = Date.now();
      await updateDoc(ref, { checkOut: nowVal, status: "left" });
      setAttMap((m) => ({
        ...m,
        [String(emp.id)]: { ...existing, checkOut: nowVal, status: "left" },
      }));
      setNow(Date.now());
      pushToast({ kind: "success", text: `Saída registrada para ${emp.name}` });
    } catch (e) {
      pushToast({
        kind: "error",
        text: e instanceof Error ? e.message : "Erro no check-out",
      });
    }
  };

  // Exportar CSV (hoje) — amigável ao Excel (sep=; + BOM)
  const handleExportCsvToday = () => {
    const date = todayStr();
    const sep = ";";
    const rows: string[][] = [
      ["Funcionario", "Entrada", "Saida", "Minutos", "Horas(h:m)"],
    ];

    const fmtTime = (t?: number) => (t ? new Date(t).toLocaleTimeString() : "");
    const toHM = (mins: number) => `${Math.floor(mins / 60)}h ${mins % 60}m`;

    const list = employees.filter(
      (e): e is Employee & { id: string } => !!e.id
    );
    list.forEach((e) => {
      const att = attMap[String(e.id)];
      const endMs = Date.now();
      const mins = att?.checkIn
        ? Math.floor(Math.max(0, (att.checkOut ?? endMs) - att.checkIn) / 60000)
        : 0;

      rows.push([
        e.name,
        fmtTime(att?.checkIn),
        fmtTime(att?.checkOut),
        String(mins),
        toHM(mins),
      ]);
    });

    const csvBody = rows
      .map((r) =>
        r
          .map((cell) => {
            const v = (cell ?? "").toString();
            if (
              v.includes(sep) ||
              v.includes(",") ||
              v.includes('"') ||
              v.includes("\n")
            ) {
              return `"${v.replace(/"/g, '""')}"`;
            }
            return v;
          })
          .join(sep)
      )
      .join("\n");

    const csv = `sep=${sep}\n` + csvBody;
    const blob = new Blob([new TextEncoder().encode("\uFEFF" + csv)], {
      type: "text/csv;charset=utf-8;",
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `attendance_${date}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!ready || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        Carregando…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-5xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold">Presenças (Attendance)</h1>
          <p className="text-sm text-gray-600">
            Registre entrada/saída de hoje por funcionário.
          </p>

          <div className="mt-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nome..."
              className="w-full md:w-80 rounded-lg border px-3 py-2 text-sm"
            />
          </div>

          <div className="mt-2">
            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as typeof statusFilter)
              }
              className="w-full md:w-60 rounded-lg border px-3 py-2 text-sm"
              title="Filtrar por status do dia"
            >
              <option value="all">Todos os status</option>
              <option value="present">Em andamento</option>
              <option value="left">Finalizado</option>
              <option value="pending">Pendente</option>
            </select>
          </div>

          <div className="mt-3">
            <button
              type="button"
              onClick={handleExportCsvToday}
              className="rounded-md border px-3 py-1 text-sm"
              title="Exporta a tabela de hoje em CSV"
            >
              Exportar CSV (hoje)
            </button>
          </div>

          {err && <p className="text-sm text-red-600 mt-2">{err}</p>}
        </header>

        {loading ? (
          <p>Carregando…</p>
        ) : viewEmployees.length === 0 ? (
          <p className="text-sm text-gray-600">
            Nenhum funcionário ativo. Cadastre em /employees.
          </p>
        ) : (
          <div className="bg-white rounded-xl shadow p-4">
            {/* Controles de paginação */}
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
                      Funcionário {nameAsc ? "▲" : "▼"}
                    </button>
                  </th>
                  <th className="py-2 pr-3">Entrada</th>
                  <th className="py-2 pr-3">Saída</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Previsto (hoje)</th>
                  <th className="py-2 pr-3">Cumprimento</th>
                  <th className="py-2 pr-3">Horas (hoje)</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {pagedEmployees.map((e) => {
                  const att = attMap[e.id]; // <— (corrigido) uma única linha, e.id correto
                  const fmt = (t?: number) =>
                    t ? new Date(t).toLocaleTimeString() : "-";
                  const plannedStr = plannedLabelToday(e);
                  const badge = complianceBadge(att, e, now);

                  return (
                    <tr key={e.id} className="border-b last:border-0">
                      <td className="py-2 pr-3">{e.name}</td>
                      <td className="py-2 pr-3">{fmt(att?.checkIn)}</td>
                      <td className="py-2 pr-3">{fmt(att?.checkOut)}</td>
                      <td className="py-2 pr-3">
                        <span
                          className={`px-2 py-1 rounded-full text-xs ${
                            att?.status === "present"
                              ? "bg-green-100 text-green-700"
                              : att?.status === "left"
                              ? "bg-gray-200 text-gray-700"
                              : "bg-yellow-100 text-yellow-800"
                          }`}
                        >
                          {att?.status ?? "pending"}
                        </span>
                      </td>
                      <td className="py-2 pr-3">{plannedStr}</td>
                      <td className="py-2 pr-3">
                        <span
                          className={`px-2 py-1 rounded-full text-xs ${badge.cls}`}
                        >
                          {badge.text}
                        </span>
                      </td>
                      <td className="py-2 pr-3">{workedToday(att, now)}</td>
                      <td className="py-2 pr-3">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => handleCheckIn(e)}
                            className="relative z-10 cursor-pointer pointer-events-auto rounded-md border px-2 py-1"
                          >
                            Entrada
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCheckOut(e)}
                            disabled={!att?.checkIn || !!att?.checkOut}
                            title={
                              !att?.checkIn
                                ? "Primeiro registre a Entrada"
                                : att?.checkOut
                                ? "Este funcionário já finalizou o turno hoje"
                                : ""
                            }
                            className={`relative z-10 rounded-md border px-2 py-1 ${
                              !att?.checkIn || !!att?.checkOut
                                ? "opacity-50 cursor-not-allowed"
                                : "cursor-pointer pointer-events-auto"
                            }`}
                          >
                            Saída
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Toast container (uma vez só, fora do map) */}
            <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50">
              {toasts.map((t) => (
                <div
                  key={t.id}
                  className={[
                    "min-w-[220px] max-w-[320px] rounded-lg px-3 py-2 shadow text-sm",
                    t.kind === "success" && "bg-green-600 text-white",
                    t.kind === "error" && "bg-red-600 text-white",
                    t.kind === "info" && "bg-gray-800 text-white",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {t.text}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
