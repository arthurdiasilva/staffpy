// src/types.ts
export type Employee = {
  id?: string; // preenchido quando lido do Firestore
  ownerId: string; // UID do dono (auth)
  name: string; // nome do funcionário
  role: string; // função/cargo
  salaryBase?: number; // salário base (opcional)
  workDays?: string[]; // dias (ex.: ["seg","ter","qua"])
  active: boolean; // status
  createdAt: number; // Date.now()
};
