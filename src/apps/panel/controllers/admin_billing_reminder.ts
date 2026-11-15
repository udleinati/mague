// Panel admin para Lembrete de cobrança (ADR 0028) + filtros/plano (ADR 0039).
// Espelha admin_insurance.ts.

import { render } from "$panel/render.ts";
import { currentCondominiumId } from "$panel/context.ts";
import { listAccessibleCondominiums } from "./auth.ts";
import { client } from "$panel/client.ts";

export interface BillingFilters {
  overdue: 1 | 30 | 60 | 90;
  plan: "all" | "with" | "without";
}

/** Normaliza os query params do filtro (raw string) para valores canónicos. */
export function normalizeBillingFilters(
  raw: { overdue?: string | null; plan?: string | null },
): BillingFilters {
  const o = Number(raw.overdue);
  const overdue = o === 1 ? 1 : o === 60 ? 60 : o === 90 ? 90 : 30;
  const plan = raw.plan === "with" || raw.plan === "without" ? raw.plan : "all";
  return { overdue, plan };
}

/** Frações com quotas em atraso, filtradas por bloco (+1/+30/+60/+90) + plano. */
export async function listPage(
  filters: BillingFilters = { overdue: 30, plan: "all" },
  flash?: { type: string; message: string },
) {
  const [overdueRes, availableCondominiums] = await Promise.all([
    client.admin.listBillingOverdueUnits(filters),
    listAccessibleCondominiums(),
  ]);
  const data = overdueRes.data;
  return await render("pages/billing_reminders/list.vto", {
    title: "Lembretes de cobrança",
    section: "billing-reminders",
    availableCondominiums,
    currentCondominiumId: currentCondominiumId(),
    reconciledThroughDate: data.reconciledThroughDate,
    guard: data.guard,
    units: data.units,
    filters,
    flash,
  });
}

export async function sendOne(
  unitId: string,
  trigger: "individual" | "bulk" = "individual",
) {
  const res = await client.admin.sendBillingReminder(unitId, { trigger });
  return res.data;
}

/** Grava a nota livre da administração no condomínio (topo do email). */
export async function saveNote(note: string | null) {
  await client.admin.updateMe({ billingReminderNote: note });
  return { ok: true };
}
