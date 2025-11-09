// src/types.ts

// Dias da semana (0 = Domingo ... 6 = Sábado)
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAY_LABEL: Record<Weekday, string> = {
  0: "Dom",
  1: "Seg",
  2: "Ter",
  3: "Qua",
  4: "Qui",
  5: "Sex",
  6: "Sáb",
};

// Um “bloco de horário” (ex.: Seg/Qua/Sex das 09:00 às 18:00)
export type ScheduleEntry = {
  days: Weekday[]; // ex.: [1,3,5] (Seg, Qua, Sex)
  start: string;   // "HH:MM" (24h)
  end: string;     // "HH:MM" (24h)
};

export type Employee = {
  id?: string;            // ← agora opcional (corrige o erro de “id missing”)
  ownerId: string;
  name: string;
  role: string;
  salaryBase?: number;
  workDays?: string[];    // se seu código antigo usar string, me avise que deixo: string[] | string
  active: boolean;
  createdAt?: number;
  schedule?: ScheduleEntry[];
};
