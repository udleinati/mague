// Estado efetivo de uma charge para display - fonte única do "Vencido" (ADR
// 0037). O `status` gravado mente nos dois sentidos; a verdade é a regra da
// view v_unit_balance: saldo aberto E due_date <= cutoff E
// cutoff definido. Sem cutoff, NADA é vencido. Helpers injetados como globais
// de template em render.ts.

export type BadgeTone =
  | "success"
  | "warning"
  | "error"
  | "info"
  | "neutral"
  | "muted";

export interface StatusBadgeProps {
  label: string;
  tone: BadgeTone;
}

export interface ChargeStatusInput {
  status?: string | null;
  dueDate?: string | null;
  openAmount?: number | string | null;
}

/** Regra canónica do "Vencido" - ver doc do módulo. Datas ISO (YYYY-MM-DD)
 * comparam lexicograficamente. */
export function isChargeOverdue(
  c: ChargeStatusInput,
  cutoff?: string | null,
): boolean {
  if (c.status === "paid" || c.status === "cancelled") return false;
  if (Number(c.openAmount ?? 0) <= 0) return false;
  if (!c.dueDate || !cutoff) return false;
  return c.dueDate <= cutoff;
}

// Badge { label, tone } para status_badge.vto / page_header.vto.
// `paidLabel`/`openLabel` dão contexto de créditos ("Aplicado"/"Por aplicar").
export function chargeStatusBadge(
  c: ChargeStatusInput,
  cutoff?: string | null,
  opts?: { paidLabel?: string; openLabel?: string } | null,
): StatusBadgeProps {
  if (c.status === "paid") {
    return { label: opts?.paidLabel ?? "Pago", tone: "success" };
  }
  if (c.status === "cancelled") return { label: "Cancelado", tone: "muted" };
  if (isChargeOverdue(c, cutoff)) return { label: "Vencido", tone: "error" };
  if (c.status === "partial") return { label: "Parcial", tone: "warning" };
  return { label: opts?.openLabel ?? "Aberto", tone: "neutral" };
}
