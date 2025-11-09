// src/app/attendance/history/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { auth, db } from "../../../lib/firebase";
import { onAuthStateChanged, User } from "firebase/auth";
import {
  collection,
  getDocs,
  query,
  where,
  doc,
  setDoc,
  deleteDoc,
  getDoc,
} from "firebase/firestore";
import type { Employee } from "../../../types";

type Attendance = {
  id?: string;
  ownerId: string;
  employeeId: string;
  employeeName: string;
  date: string; // YYYY-MM-DD
  checkIn?: number;
  checkOut?: number;
  status: "pending" | "present" | "left";
};

function toYMD(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function startOfWeek(d = new Date()) {
  const n = new Date(d);
  const dow = n.getDay(); // 0=Dom
  const diff = (dow + 6) % 7; // começa na segunda
  n.setDate(n.getDate() - diff);
  n.setHours(0, 0, 0, 0);
  return n;
}
function addDays(d: Date, delta: number) {
  const n = new Date(d);
  n.setDate(n.getDate() + delta);
  return n;
}
function msToHMM(ms?: number) {
  if (!ms || ms <= 0) return "0h 0m";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}
function hhmmToMsOnDate(hhmm: string, dateStr: string) {
  const [hh, mm] = hhmm.split(":").map((x) => parseInt(x, 10));
  const d = new Date(dateStr + "T00:00:00");
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}
function msToHHMM(ms?: number) {
  if (!ms) return "";
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export default function AttendanceHistoryPage() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  const employeesCol = useMemo(() => collection(db, "employees"), []);
  const attendanceCol = useMemo(() => collection(db, "attendance"), []);

  // período (semana corrente por padrão)
  const [monday, setMonday] = useState<Date>(startOfWeek());
  const [days, setDays] = useState<string[]>([]);

  // dados
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [attByKey, setAttByKey] = useState<Record<string, Attendance | undefined>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // editor inline
  const [editKey, setEditKey] = useState<string | null>(null); // `${empId}__${date}`
  const [inTime, setInTime] = useState<string>("");
  const [outTime, setOutTime] = useState<string>("");

  // auth
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setReady(true);
      if (!u) window.location.href = "/login";
    });
    return () => unsub();
  }, []);

  // gera array de datas (segunda..domingo)
  useEffect(() => {
    const arr: string[] = [];
    for (let i = 0; i < 7; i++) arr.push(toYMD(addDays(monday, i)));
    setDays(arr);
  }, [monday]);

  // carrega funcionários
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
        setErr(e instanceof Error ? e.message : "Erro ao carregar funcionários");
      }
    })();
  }, [user, employeesCol]);

  // carrega presenças do dono e filtra por semana em memória
  async function refreshAttendance(rangeDays: string[]) {
    if (!user || rangeDays.length === 0) return;
    setLoading(true);
    setErr(null);
    try {
      const qAtt = query(attendanceCol, where("ownerId", "==", user.uid));
      const snap = await getDocs(qAtt);
      const map: Record<string, Attendance> = {};
      const dateSet = new Set(rangeDays);
      snap.forEach((d) => {
        const att = d.data() as Attendance;
        if (!dateSet.has(att.date)) return;
        map[`${att.employeeId}__${att.date}`] = { id: d.id, ...att };
      });
      setAttByKey(map);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Erro ao carregar histórico");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshAttendance(days);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, attendanceCol, days]);

  const moveWeek = (delta: number) => {
    setMonday(startOfWeek(addDays(monday, delta * 7)));
  };

  // abrir editor
  const openEditor = (emp: Employee, date: string) => {
    const key = `${emp.id}__${date}`;
    const att = attByKey[key];
    setEditKey(key);
    setInTime(msToHHMM(att?.checkIn));
    setOutTime(msToHHMM(att?.checkOut));
  };

  const cancelEditor = () => {
    setEditKey(null);
    setInTime("");
    setOutTime("");
  };

  // salvar (cria ou atualiza)
  const saveEditor = async (emp: Employee, date: string) => {
    if (!user || !emp.id) return;
    // se preencheu só saída sem entrada, não permitimos
    if (!inTime && outTime) {
      alert("Informe a Entrada antes de definir a Saída.");
      return;
    }

    const checkIn = inTime ? hhmmToMsOnDate(inTime, date) : undefined;
    const checkOut = outTime ? hhmmToMsOnDate(outTime, date) : undefined;

    if (checkIn && checkOut && checkOut < checkIn) {
      alert("Saída não pode ser menor que Entrada.");
      return;
    }

    const docId = `${user.uid}__${emp.id}__${date}`;
    const ref = doc(db, "attendance", docId);
    const snap = await getDoc(ref);

    // status calculado
    let status: Attendance["status"] = "pending";
    if (checkIn && !checkOut) status = "present";
    if (checkIn && checkOut) status = "left";

    if (!snap.exists()) {
      // criar
      const newAtt: Attendance = {
        ownerId: user.uid,
        employeeId: emp.id,
        employeeName: emp.name,
        date,
        ...(checkIn ? { checkIn } : {}),
        ...(checkOut ? { checkOut } : {}),
        status,
      };
      await setDoc(ref, newAtt);
    } else {
      // atualizar
      const patch: Partial<Attendance> = {
        status,
      };
      if (checkIn !== undefined) patch.checkIn = checkIn;
      else patch.checkIn = undefined as unknown as number; // limpar se vazio

      if (checkOut !== undefined) patch.checkOut = checkOut;
      else patch.checkOut = undefined as unknown as number; // limpar se vazio

    await setDoc(ref, patch, { merge: true });
    }

    await refreshAttendance(days);
    cancelEditor();
  };

  // limpar registro do dia (apagar doc)
  const clearDay = async (emp: Employee, date: string) => {
    if (!user || !emp.id) return;
    const ok = confirm(`Remover o ponto de ${emp.name} em ${date}?`);
    if (!ok) return;
    const docId = `${user.uid}__${emp.id}__${date}`;
    await deleteDoc(doc(db, "attendance", docId));
    await refreshAttendance(days);
    cancelEditor();
  };

  return !ready || !user ? (
    <div className="min-h-screen flex items-center justify-center">Carregando…</div>
  ) : (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-6xl mx-auto">
        <header className="mb-4 flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Histórico de Presenças</h1>
          <div className="ml-auto flex items-center gap-2">
            <button
              className="rounded-md border px-2 py-1 text-sm"
              onClick={() => moveWeek(-1)}
            >
              ◀ Semana anterior
            </button>
            <button
              className="rounded-md border px-2 py-1 text-sm"
              onClick={() => setMonday(startOfWeek())}
            >
              Hoje
            </button>
            <button
              className="rounded-md border px-2 py-1 text-sm"
              onClick={() => moveWeek(1)}
            >
              Semana seguinte ▶
            </button>
          </div>
        </header>

        {err && <p className="text-sm text-red-600 mb-3">{err}</p>}

        <div className="bg-white rounded-xl shadow p-4 overflow-x-auto">
          {loading ? (
            <p>Carregando…</p>
          ) : employees.length === 0 ? (
            <p className="text-sm text-gray-600">
              Nenhum funcionário. Cadastre em /employees.
            </p>
          ) : (
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pr-3">Funcionário</th>
                  {days.map((d) => (
                    <th key={d} className="py-2 pr-3">
                      {d}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => (
                  <tr key={e.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">{e.name}</td>
                    {days.map((d) => {
                      const key = `${e.id}__${d}`;
                      const att = attByKey[key];
                      const minutes =
                        att?.checkIn
                          ? Math.floor(
                              Math.max(0, (att.checkOut ?? att.checkIn) - att.checkIn) / 60000
                            )
                          : 0;
                      const isEditing = editKey === key;

                      return (
                        <td key={d} className="py-2 pr-3 align-top">
                          {!isEditing ? (
                            <div className="space-y-1">
                              <div>In: {att ? new Date(att.checkIn ?? 0).toLocaleTimeString() : "-"}</div>
                              <div>Out: {att?.checkOut ? new Date(att.checkOut).toLocaleTimeString() : "-"}</div>
                              <div className="text-xs text-gray-600">
                                {minutes} min ({msToHMM(minutes * 60_000)})
                              </div>
                              <button
                                className="mt-1 rounded-md border px-2 py-0.5 text-xs"
                                onClick={() => openEditor(e, d)}
                              >
                                Corrigir
                              </button>
                            </div>
                          ) : (
                            <div className="space-y-2 p-2 rounded-md border">
                              <div className="flex items-center gap-2">
                                <label className="text-xs">Entrada</label>
                                <input
                                  type="time"
                                  value={inTime}
                                  onChange={(ev) => setInTime(ev.target.value)}
                                  className="border rounded px-2 py-1 text-xs"
                                />
                              </div>
                              <div className="flex items-center gap-2">
                                <label className="text-xs">Saída</label>
                                <input
                                  type="time"
                                  value={outTime}
                                  onChange={(ev) => setOutTime(ev.target.value)}
                                  className="border rounded px-2 py-1 text-xs"
                                />
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  className="rounded-md border px-2 py-1 text-xs"
                                  onClick={() => saveEditor(e, d)}
                                >
                                  Salvar
                                </button>
                                <button
                                  className="rounded-md border px-2 py-1 text-xs"
                                  onClick={cancelEditor}
                                >
                                  Cancelar
                                </button>
                                {att && (
                                  <button
                                    className="rounded-md border px-2 py-1 text-xs text-red-600"
                                    onClick={() => clearDay(e, d)}
                                  >
                                    Limpar
                                  </button>
                                )}
                              </div>
                              <p className="text-[10px] text-gray-500">
                                Dica: deixe vazio para limpar Entrada/Saída individualmente.
                              </p>
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
