import { render } from "$panel/render.ts";
import { parseEurosToCents } from "$shared/money/parse_euros.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { client } from "$panel/client.ts";

export async function listRecurring() {
  const [templates, accounts, suppliers] = await Promise.all([
    client.admin.listRecurringTemplates(),
    client.admin.listExpenseCategories(),
    client.admin.listSuppliers(),
  ]);

  const today = new Date().toISOString().slice(0, 10);

  return await render("pages/recurring/list.vto", {
    title: "Despesas Recorrentes",
    section: "recurring",
    templates: templates.data,
    accounts: accounts.data,
    suppliers: suppliers.data,
    today,
  });
}

export async function createTemplate(form: Record<string, string | File>) {
  await client.admin.createRecurringTemplate({
    kind: parseFormString(form, "kind", { default: "payable" }),
    description: parseFormString(form, "description"),
    amount: parseEurosToCents(form.amount) ?? 0,
    accountId: parseFormString(form, "accountId", { emptyAsNull: true }),
    supplierId: parseFormString(form, "supplierId", { emptyAsNull: true }),
    intervalType: parseFormString(form, "intervalType", { default: "monthly" }),
    paymentMethod: parseFormString(form, "paymentMethod", { default: "manual" }),
    dayOfMonth: form.dayOfMonth ? parseInt(String(form.dayOfMonth), 10) : null,
    startDate: parseFormString(form, "startDate"),
    nextRunDate: String(form.nextRunDate ?? form.startDate ?? ""),
    notes: parseFormString(form, "notes", { emptyAsNull: true }),
  });
  return { ok: true };
}

export async function updateTemplate(templateId: string, form: Record<string, string | File>) {
  await client.admin.updateRecurringTemplate(templateId, {
    description: parseFormString(form, "description"),
    amount: parseEurosToCents(form.amount) ?? 0,
    accountId: parseFormString(form, "accountId", { emptyAsNull: true }),
    supplierId: parseFormString(form, "supplierId", { emptyAsNull: true }),
    intervalType: parseFormString(form, "intervalType", { default: "monthly" }),
    paymentMethod: parseFormString(form, "paymentMethod", { default: "manual" }),
    dayOfMonth: form.dayOfMonth ? parseInt(String(form.dayOfMonth), 10) : null,
    nextRunDate: parseFormString(form, "nextRunDate"),
    notes: parseFormString(form, "notes", { emptyAsNull: true }),
  });
  return { ok: true };
}

/** Toggle isActive - pausa/retoma geração sem apagar o template. */
export async function toggleTemplate(templateId: string, isActive: boolean) {
  await client.admin.updateRecurringTemplate(templateId, { isActive });
  return { ok: true };
}

export async function deleteTemplate(templateId: string) {
  await client.admin.deleteRecurringTemplate(templateId);
  return { ok: true };
}

export async function triggerRun(form: Record<string, string | File>) {
  const r = await client.admin.triggerRecurringRun({
    throughDate: String(form.throughDate ?? ""),
    notes: parseFormString(form, "notes", { emptyAsNull: true }),
  });
  return { run: r.data };
}
