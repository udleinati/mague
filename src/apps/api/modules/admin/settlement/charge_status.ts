// Helper puro: status gravado de uma charge DEPOIS de um settlement (regra
// única, sem gémea SQL). O status inicial (`open`/`overdue`) é definido inline
// pelos geradores de quotas e de recorrentes. NB: usa due_date < hoje; o
// "vencido" de display usa a regra de cutoff (panel/libs/charge_status.ts).

export function computeChargeStatus(
  settled: number,
  open: number,
  dueDate: string | null,
  current: string,
  today: Date,
): string {
  if (current === "cancelled" || current === "disputed") return current;
  if (open <= 0) return "paid";
  if (settled > 0) return "partial";
  if (dueDate !== null && dueDate < today.toISOString().slice(0, 10)) return "overdue";
  return "open";
}
