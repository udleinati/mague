import { render } from "$panel/render.ts";
import { parseFormInt, parseFormString } from "$panel/libs/form_parsing.ts";
import { parseEurosToCents } from "$shared/money/parse_euros.ts";
import { client } from "$panel/client.ts";
import { proxyDownload } from "$panel/libs/download_proxy.ts";

export async function listBudgets(showNotApproved = false) {
  const [budgetsResult, categoriesResult] = await Promise.all([
    client.admin.listBudgets(),
    client.admin.listExpenseCategories(),
  ]);

  const currentYear = new Date().getFullYear();

  // Propostas preteridas ficam escondidas por defeito (histórico); o toggle
  // "?nao-aprovados=1" revela-as. Contagem feita antes do filtro p/ o link.
  const notApprovedCount = budgetsResult.data.filter((b) => b.status === "not_approved").length;

  // A API só ordena por ano desc; anos iguais vêm intercalados, fazendo
  // suplementares de um ano aparecerem soltos sob o principal de outro ano.
  // Agrupar: cada principal (ano desc) seguido logo dos seus suplementares.
  const all = showNotApproved
    ? budgetsResult.data
    : budgetsResult.data.filter((b) => b.status !== "not_approved");
  const principals = all
    .filter((b) => b.type === "principal")
    .sort((a, b) => Number(b.year) - Number(a.year));
  const supplementsByParent = new Map<string, typeof all>();
  for (const b of all) {
    if (b.type !== "suplementar") continue;
    const key = b.parentBudgetId ?? "";
    const list = supplementsByParent.get(key);
    if (list) list.push(b);
    else supplementsByParent.set(key, [b]);
  }
  // Suplementares de cada principal ordenados pela descrição (notes).
  for (const list of supplementsByParent.values()) {
    list.sort((a, b) => (a.notes ?? "").localeCompare(b.notes ?? "", "pt"));
  }
  const budgets: typeof all = [];
  for (const p of principals) {
    budgets.push(p);
    const children = supplementsByParent.get(p.id);
    if (children) {
      budgets.push(...children);
      supplementsByParent.delete(p.id);
    }
  }
  // Suplementares órfãos (pai inexistente/apagado) vão para o fim.
  for (const list of supplementsByParent.values()) budgets.push(...list);

  const html = await render("pages/budget/list.vto", {
    title: "Orçamentos",
    section: "budget",
    budgets,
    categories: categoriesResult.data,
    currentYear,
    defaultYear: currentYear + 1,
    notApprovedCount,
    showNotApproved,
  });
  return html;
}

export async function getBudget(budgetId: string) {
  const [budgetResult, categoriesResult, quotaMapResult] = await Promise.all([
    client.admin.getBudget(budgetId),
    client.admin.listExpenseCategories(),
    // Pode falhar se o orçamento ainda não tem linhas/frações válidas; ignorar.
    client.admin.getBudgetQuotaMap(budgetId).catch(() => null),
  ]);

  const budget = budgetResult.data;
  // `lines` já vêm enriquecidas (categoryCode/categoryDescription) e
  // ordenadas pela API - ver budget/_projection.ts.
  const lines = budget.lines ?? [];
  const ordinaryTotal = lines.reduce((sum, l) => sum + l.annualAmount, 0);
  const fcrAmount = Number(budget.fcrAmount);
  const grandTotal = ordinaryTotal + fcrAmount;

  // `quotaMap.units` já trazem o `identifier` (LEFT JOIN core.unit no handler).
  const quotaMap = quotaMapResult?.data ?? null;

  // Default do mês da 1ª prestação (suplementar): próximo mês civil.
  const now = new Date();
  const fm = now.getMonth() + 2; // 0-based +1 (próximo mês) +1 (1-based)
  const fy = fm > 12 ? now.getFullYear() + 1 : now.getFullYear();
  const defaultFirstMonth = `${fy}-${String(fm > 12 ? fm - 12 : fm).padStart(2, "0")}`;

  const html = await render("pages/budget/show.vto", {
    title: `Orçamento ${budget.year}`,
    section: "budget",
    target: budget,
    lines,
    categories: categoriesResult.data,
    ordinaryTotal,
    fcrAmount,
    grandTotal,
    quotaMap,
    defaultFirstMonth,
  });
  return html;
}

export async function createBudget(form: Record<string, string | File>) {
  const yearRaw = parseFormString(form, "year");
  const year = Number.parseInt(yearRaw, 10);
  if (!Number.isFinite(year) || year < 2000 || year > 2100) {
    throw new Error("Ano inválido (entre 2000 e 2100).");
  }

  // FCR vazio → omitido: a API aplica o default por tipo (0% suplementar, 10% principal).
  const fcrPctRaw = String(form.fcrPercentage ?? "").replace(",", ".").trim();
  const fcrPercentage = fcrPctRaw === "" ? null : Number.parseFloat(fcrPctRaw);

  const type = parseFormString(form, "type", { default: "principal" });
  if (type !== "principal" && type !== "suplementar") {
    throw new Error("Tipo inválido. Usa 'principal' ou 'suplementar'.");
  }

  const notes = parseFormString(form, "notes");

  const body: Record<string, unknown> = {
    year: String(year),
    notes: notes || null,
  };
  // Suplementar não envia FCR (a API força 0); só o principal o define.
  if (type === "principal" && fcrPercentage !== null && Number.isFinite(fcrPercentage)) {
    body.fcrPercentage = String(fcrPercentage);
  }
  if (type === "suplementar") {
    const parentId = parseFormString(form, "parentBudgetId");
    if (!parentId) throw new Error("Orçamento suplementar exige o orçamento pai aprovado.");
    body.parentBudgetId = parentId;
    const installments = parseFormInt(form, "installments");
    if (!installments || installments < 1) {
      throw new Error("Orçamento suplementar exige o nº de prestações (>= 1).");
    }
    body.installments = installments;
  }

  const created = await client.admin.createBudget(body);
  return { created: created.data };
}

export async function editBudget(budgetId: string, form: Record<string, string | File>) {
  const notes = parseFormString(form, "notes");
  await client.admin.updateBudget(budgetId, { notes: notes || null });
  return { id: budgetId };
}

export async function deleteBudget(budgetId: string) {
  await client.admin.deleteBudget(budgetId);
  return { deleted: true };
}

export async function rejectBudget(budgetId: string) {
  await client.admin.rejectBudget(budgetId);
  return { id: budgetId };
}

export async function reopenBudget(budgetId: string) {
  await client.admin.reopenBudget(budgetId);
  return { id: budgetId };
}

export async function addBudgetLine(budgetId: string, form: Record<string, string | File>) {
  const categoryId = parseFormString(form, "accountId");
  const annualAmount = parseEurosToCents(form.annualAmount);
  if (annualAmount === null) {
    return { error: "Valor anual inválido." };
  }

  const line = await client.admin.createBudgetLine(budgetId, {
    accountId: categoryId,
    annualAmount: annualAmount,
  });

  return { line: line.data };
}

export async function updateBudgetLine(
  budgetId: string,
  lineId: string,
  form: Record<string, string | File>,
) {
  const categoryId = parseFormString(form, "accountId");
  const annualAmount = parseEurosToCents(form.annualAmount);
  if (annualAmount === null) {
    return { error: "Valor anual inválido." };
  }

  const updated = await client.admin.updateBudgetLine(budgetId, lineId, {
    accountId: categoryId,
    annualAmount: annualAmount,
  });

  return { line: updated.data };
}

export async function deleteBudgetLine(budgetId: string, lineId: string) {
  await client.admin.deleteBudgetLine(budgetId, lineId);
  return { deleted: true };
}

/** GET budget/:id/pdf - proxy ao endpoint /pdf da API (passthrough de bytes). */
export async function downloadBudgetPdf(budgetId: string): Promise<Response> {
  const upstream = await client.admin.downloadStream(`/budgets/${budgetId}/pdf`);
  return proxyDownload(upstream, {
    errorPrefix: "Erro ao gerar PDF do orçamento",
    contentType: "application/pdf",
    cacheControl: "no-store",
  });
}
