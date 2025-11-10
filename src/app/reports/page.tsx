// src/app/reports/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { auth, db } from "../../lib/firebase";
import { onAuthStateChanged, User } from "firebase/auth";
import { collection, getDocs, query, where } from "firebase/firestore";

type Employee = {
  id: string;
  ownerId: string;
  name: string;
  role?: string;
  active: boolean;
};

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

// ===== helpers =====
function toYMD(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function startOfWeek(d = new Date()) {
  const n = new Date(d);
  const day = n.getDay(); // 0=Dom
  const diff = (day + 6) % 7; // começa na segunda
  n.setDate(n.getDate() - diff);
  n.setHours(0, 0, 0, 0);
  return n;
}
function startOfMonth(d = new Date()) {
  const n = new Date(d.getFullYear(), d.getMonth(), 1);
  n.setHours(0, 0, 0, 0);
  return n;
}
function msToHMM(ms: number) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

export default function ReportsPage() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  const employeesCol = useMemo(() => collection(db, "employees"), []);
  const attendanceCol = useMemo(() => collection(db, "attendance"), []);

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [range, setRange] = useState<"week" | "month">("week");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // agora guardamos dias trabalhados e minutos totais (para exibir h:m)
  const [rows, setRows] = useState<
    Array<{ id: string; name: string; days: number; minutes: number }>
  >([]);
  // normaliza pra busca sem acentos/maiúsculas
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

  // estado da busca + linhas filtradas
  const [search, setSearch] = useState("");
  const filteredRows = useMemo(
    () => rows.filter((r) => normalize(r.name).includes(normalize(search))),
    [rows, search]
  );

  // ordem por nome
  const [nameAsc, setNameAsc] = useState(true);

  // aplica ordenação sobre o filtrado
  const viewRows = useMemo(
    () =>
      [...filteredRows].sort((a, b) =>
        nameAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
      ),
    [filteredRows, nameAsc]
  );

  // total geral (considera a lista que está sendo exibida)
  const totalMinutes = useMemo(
    () => viewRows.reduce((sum, r) => sum + r.minutes, 0),
    [viewRows]
  );
  const totalHM = `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;

  // auth
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setReady(true);
      if (!u) window.location.href = "/login";
    });
    return () => unsub();
  }, []);

  // funcionários
  useEffect(() => {
    (async () => {
      if (!user) return;
      try {
        const qEmp = query(employeesCol, where("ownerId", "==", user.uid));
        const snap = await getDocs(qEmp);
        const list: Employee[] = [];
        snap.forEach((d) => {
          const v = d.data() as Omit<Employee, "id">;
          list.push({ id: d.id, ...v });
        });
        list.sort((a, b) => a.name.localeCompare(b.name));
        setEmployees(list);
      } catch (e) {
        setErr(
          e instanceof Error ? e.message : "Erro ao carregar funcionários"
        );
      }
    })();
  }, [user, employeesCol]);

  // agregação por período (dias trabalhados + minutos totais)
  useEffect(() => {
    (async () => {
      if (!user) return;
      setLoading(true);
      setErr(null);
      try {
        const now = new Date();
        const start = range === "week" ? startOfWeek(now) : startOfMonth(now);
        const end = new Date();
        const startStr = toYMD(start);
        const endStr = toYMD(end);

        // busca por ownerId e filtra por data em memória (ok para base pequena)
        const qAtt = query(attendanceCol, where("ownerId", "==", user.uid));
        const snap = await getDocs(qAtt);

        // para cada funcionário, queremos:
        // - conjunto de datas (unique) com presença => dias trabalhados
        // - soma de minutos no período
        const daySetByEmp = new Map<string, Set<string>>();
        const minutesByEmp = new Map<string, number>();

        snap.forEach((d) => {
          const att = d.data() as Attendance;
          if (att.date < startStr || att.date > endStr) return;
          if (!att.checkIn) return;

          // dias trabalhados
          const set = daySetByEmp.get(att.employeeId) ?? new Set<string>();
          set.add(att.date);
          daySetByEmp.set(att.employeeId, set);

          // minutos totais
          const endMs = att.checkOut ?? Date.now();
          const ms = Math.max(0, endMs - att.checkIn);
          const minutes = Math.floor(ms / 60000);
          minutesByEmp.set(
            att.employeeId,
            (minutesByEmp.get(att.employeeId) ?? 0) + minutes
          );
        });

        const result = employees.map((e) => ({
          id: e.id,
          name: e.name,
          days: daySetByEmp.get(e.id)?.size ?? 0,
          minutes: minutesByEmp.get(e.id) ?? 0,
        }));
        // ordena por mais dias; em empate, por mais minutos
        result.sort((a, b) => b.days - a.days || b.minutes - a.minutes);
        setRows(result);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Erro ao carregar relatório");
      } finally {
        setLoading(false);
      }
    })();
  }, [user, attendanceCol, employees, range]);

  // CSV amigável ao Excel (sep=; + BOM) -> agora com "Dias"
  const downloadCsv = () => {
    const now = new Date();
    const title = range === "week" ? "semana" : "mes";
    const sep = ";";
    const toHM = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m`;

    const rowsData: string[][] = [
      ["Funcionario", "Dias", "Horas(h:m)"],
      ...rows.map((r) => [r.name, String(r.days), toHM(r.minutes)]),
    ];

    const csvBody = rowsData
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
    a.download = `relatorio_${title}_${toYMD(now)}.csv`;
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
          <h1 className="text-2xl font-semibold">Relatórios</h1>
          <p className="text-sm text-gray-600">
            Dias trabalhados e horas no período.
          </p>
        </header>

        <div className="mt-2 text-sm text-gray-700">
          Total do período (filtrado): <strong>{totalHM}</strong>
        </div>

        <div className="bg-white rounded-xl shadow p-4 mb-4 flex items-center gap-3">
          <label className="text-sm">Período:</label>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as "week" | "month")}
            className="border rounded-md px-2 py-1 text-sm"
          >
            <option value="week">Esta semana</option>
            <option value="month">Este mês</option>
          </select>

          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome..."
            className="rounded-md border px-3 py-1 text-sm"
          />

          <button
            type="button"
            onClick={downloadCsv}
            className="ml-auto rounded-md border px-3 py-1 text-sm"
            title="Exportar CSV do período"
          >
            Exportar CSV
          </button>
        </div>

        <div className="bg-white rounded-xl shadow p-4">
          {loading ? (
            <p>Calculando…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-gray-600">Sem dados no período.</p>
          ) : (
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
                  <th className="py-2 pr-3">Dias trabalhados</th>
                  <th className="py-2 pr-3">Horas (h:m)</th>
                </tr>
              </thead>
              <tbody>
                {viewRows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">{r.name}</td>
                    <td className="py-2 pr-3">{r.days}</td>
                    <td className="py-2 pr-3">{msToHMM(r.minutes * 60_000)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {err && <p className="text-sm text-red-600 mt-3">{err}</p>}
        </div>
      </div>
    </div>
  );
}
