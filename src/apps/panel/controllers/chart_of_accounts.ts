import { render } from "$panel/render.ts";
import { client } from "$panel/client.ts";

export async function listExpenseCategories() {
  const result = await client.admin.listExpenseCategories();

  const html = await render("pages/chart_of_accounts/list.vto", {
    title: "Categorias de despesa",
    section: "chart_of_accounts",
    categories: result.data,
  });
  return html;
}

export async function getChartOfAccount(id: string) {
  const result = await client.admin.getChartOfAccount(id);

  const html = await render("pages/chart_of_accounts/edit.vto", {
    title: "Categorias de despesa",
    section: "chart_of_accounts",
    category: result.data,
    categoryId: id,
  });
  return html;
}

export async function updateChartOfAccount(id: string, body: Record<string, string | File>) {
  const payload: Record<string, unknown> = {};
  if (typeof body.code === "string" && body.code.trim()) {
    payload.code = body.code.trim().toUpperCase();
  }
  if (typeof body.name === "string" && body.name.trim()) payload.name = body.name.trim();
  if (typeof body.type === "string" && body.type.trim()) payload.type = body.type.trim();
  if (typeof body.parentCode === "string") {
    payload.parentCode = body.parentCode.trim() || null;
  }
  if (typeof body.description === "string") {
    payload.description = body.description.trim() || null;
  }
  // Checkbox: ausente quando desmarcado, "on" quando marcado.
  payload.isActive = body.isActive === "on" || body.isActive === "true";
  await client.admin.updateChartOfAccount(id, payload);
  return { success: true };
}

export async function deleteChartOfAccount(id: string) {
  await client.admin.deleteChartOfAccount(id);
  return { success: true };
}
