// src/app/attendance/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
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

// ===== Tipos =====
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

type Employee = {
  id: string;
  ownerId: string;
  name: string;
  role?: string;
  active: boolean;
};

// ===== Utilidades =====
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

export default function AttendancePage() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [attMap, setAttMap] = useState<Record<string, Attendance | undefined>>(
    {}
  );
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // relógio: re-render a cada 5s
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  const employeesCol = useMemo(() => collection(db, "employees"), []);
  const attendanceCol = useMemo(() => collection(db, "attendance"), []);

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
    (async () => {
      if (!user) return;
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
        setEmployees(emps);

        // 2) presenças do dia (1 doc por funcionário/dia)
        const date = todayStr();
        const map: Record<string, Attendance | undefined> = {};
        for (const e of emps) {
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
        setAttMap(map);
      } catch (e) {
        const msg =
          e instanceof Error ? e.message : "Erro ao carregar presenças";
        setErr(msg);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, employeesCol, attendanceCol]);

  // ações
  const handleCheckIn = async (emp: Employee) => {
    if (!user) return;
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
        setAttMap((m) => ({ ...m, [emp.id]: { id, ...newAtt } }));
      } else {
        // novo turno: zera sempre o checkOut anterior
        await updateDoc(ref, {
          checkIn: nowVal,
          status: "present",
          checkOut: deleteField(),
        });
        setAttMap((m) => ({
          ...m,
          [emp.id]: {
            ...existing,
            checkIn: nowVal,
            status: "present",
            checkOut: undefined,
          },
        }));
      }

      setNow(Date.now()); // força atualização imediata do contador
    } catch (e) {
      alert(e instanceof Error ? e.message : "Erro no check-in");
    }
  };

  const handleCheckOut = async (emp: Employee) => {
    if (!user) return;
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
          checkOut: nowVal,
          status: "left",
        };
        await setDoc(ref, newAtt);
        setAttMap((m) => ({ ...m, [emp.id]: { id, ...newAtt } }));
        setNow(Date.now());
      } else {
        await updateDoc(ref, { checkOut: nowVal, status: "left" });
        setAttMap((m) => ({
          ...m,
          [emp.id]: { ...existing, checkOut: nowVal, status: "left" },
        }));
        setNow(Date.now());
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : "Erro no check-out");
    }
  };

  // Exportar CSV (hoje) — amigável ao Excel (sep=; + BOM UTF-8)
  const handleExportCsvToday = () => {
    const date = todayStr();
    const sep = ";";

    const rows: string[][] = [
      ["Funcionario", "Entrada", "Saida", "Minutos", "Horas(h:m)"],
    ];

    const fmtTime = (t?: number) => (t ? new Date(t).toLocaleTimeString() : "");
    const toHM = (mins: number) => `${Math.floor(mins / 60)}h ${mins % 60}m`;

    employees.forEach((e) => {
      const att = attMap[e.id];
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
          <p>Carregando equipe…</p>
        ) : employees.length === 0 ? (
          <p className="text-sm text-gray-600">
            Nenhum funcionário ativo. Cadastre em /employees.
          </p>
        ) : (
          <div className="bg-white rounded-xl shadow p-4">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pr-3">Funcionário</th>
                  <th className="py-2 pr-3">Entrada</th>
                  <th className="py-2 pr-3">Saída</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Horas (hoje)</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => {
                  const att = attMap[e.id];
                  const fmt = (t?: number) =>
                    t ? new Date(t).toLocaleTimeString() : "-";
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
                            disabled={!att?.checkIn}
                            title={
                              !att?.checkIn ? "Primeiro registre a Entrada" : ""
                            }
                            className={`relative z-10 rounded-md border px-2 py-1 ${
                              !att?.checkIn
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
          </div>
        )}
      </div>
    </div>
  );
}
