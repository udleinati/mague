import { render } from "$panel/render.ts";
import { type Charge } from "$shared/client/mod.ts";
import { buildPaginationMeta, paginationParamsFromQuery } from "$panel/libs/pagination.ts";
import { proxyDownload } from "$panel/libs/download_proxy.ts";
import { parseEurosToCents } from "$shared/money/parse_euros.ts";
import { resolveServerYearParam } from "$shared/year_filter/mod.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { lastDayOfNextMonth } from "$shared/time/month.ts";
import {
  supplierLabel as labelForSupplier,
  unitLabel as labelForUnit,
} from "$shared/labels/mod.ts";
import { client } from "$panel/client.ts";

/** Os dois tipos que o filtro trata como "quota"; o resto é "Outras". */
const QUOTA_CHARGE_TYPES = ["quota", "extraordinary_quota"] as const;

// GET /charges - três vistas (default kind=receivable+nature=debit):
//   - receivable+debit            → "A Receber" (dívida de frações)
//   - payable                     → "A Pagar" (faturas de fornecedores)
//   - receivable+credit+scope=unit → "Créditos" (condomínio deve a fração)
// "Créditos" força scope=unit: credits scope=condominium (ex: openingBalance)
// são entradas internas, não créditos a devolver - filtrados fora.
// Reusado por list.vto (página) e _list_fragment.vto (fragmento HTMX).
async function fetchChargesData(
  params: Record<string, string>,
  flash: { type: string; message: string } | null = null,
) {
  const kind = params.kind ?? "receivable";
  const nature = params.nature ?? (kind === "receivable" ? "debit" : "");
  const scope = kind === "receivable" && nature === "credit" ? "unit" : "";

  // Filtro de ano server-side (default ano atual, "" = Todos). Ver
  // resolveServerYearParam. `currentYear` é reusado abaixo nos availableYears.
  const currentYear = new Date().getUTCFullYear();
  const filterYear = resolveServerYearParam(params.year, currentYear);

  // Default "Todos": agrupamento por mês + collapse dá legibilidade sem filtrar.
  // status=open_any = pseudo-filtro composto (open|partial|overdue) da API,
  // usado pelo banner "fora do ano".
  const statusFilter = params.status ?? "";

  // Pesquisa server-side (ILIKE code+description na API) - substitui o filtro
  // client-side que só via a página corrente.
  const searchFilter = (params.search ?? "").trim();

  // Tipo (só a vista "A Receber" o mostra): quota ordinária, extraordinária ou
  // "other". "other" vai por exclusão para que um chargeType novo (juros,
  // refaturação, penalização…) caia lá sozinho, sem tocar nesta lista.
  const typeFilter = params.chargeType ?? "";

  const apiParams: Record<string, string> = { kind };
  if (nature) apiParams.nature = nature;
  if (scope) apiParams.scope = scope;
  if (filterYear !== null) apiParams.year = String(filterYear);
  if (statusFilter) apiParams.status = statusFilter;
  if (searchFilter) apiParams.search = searchFilter;
  if (typeFilter === "other") apiParams.chargeTypeNot = QUOTA_CHARGE_TYPES.join(",");
  else if (typeFilter) apiParams.chargeType = typeFilter;

  // Default 10000/página: charges é ~600 rows/ano, cabe um condo inteiro sem paginar.
  const pp = paginationParamsFromQuery(params, 10000, 10000);
  apiParams.page = pp.page;
  apiParams.perPage = pp.perPage;

  // suppliers+accounts só são precisos no modal "+ Nova despesa" (vista payable);
  // em receivable poupamos ~360 supplier rows por carregamento.
  const needsSupplierPickers = kind === "payable";
  const [chargesRes, suppliers, accounts] = await Promise.all([
    client.admin.listChargesWithMeta(apiParams),
    needsSupplierPickers
      ? client.admin.listSuppliers().catch(() => ({ data: [] }))
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    needsSupplierPickers
      ? client.admin.listExpenseCategories().catch(() => ({ data: [] }))
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
  ]);

  // API devolve DESC; o panel quer ASC (user lê cronológico de cima para baixo).
  const sortedCharges = [...chargesRes.data].sort((a, b) => {
    const ka = String(a.competencePeriod ?? a.issueDate ?? "");
    const kb = String(b.competencePeriod ?? b.issueDate ?? "");
    if (ka !== kb) return ka.localeCompare(kb);
    return String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
  });

  // ── Agrupamento por mês ─────────────────────────────────────────────
  // Cada grupo traz resumo (count + abertos/vencidos/pagos). Credits têm sign
  // negativo (redução de dívida), somados com sign para leitura coerente.
  const MONTHS_PT = [
    "Janeiro",
    "Fevereiro",
    "Março",
    "Abril",
    "Maio",
    "Junho",
    "Julho",
    "Agosto",
    "Setembro",
    "Outubro",
    "Novembro",
    "Dezembro",
  ];
  function formatMonthLabel(yyyy_mm: string): string {
    if (!yyyy_mm || yyyy_mm === "sem-data") return "Sem competência";
    const [y, m] = yyyy_mm.split("-");
    const idx = Number(m) - 1;
    if (idx < 0 || idx > 11) return yyyy_mm;
    return `${MONTHS_PT[idx]} ${y}`;
  }

  const monthBuckets = new Map<string, Charge[]>();
  for (const c of sortedCharges) {
    const m = c.competencePeriod ?? "sem-data";
    const arr = monthBuckets.get(m) ?? [];
    arr.push(c);
    monthBuckets.set(m, arr);
  }
  // open e partial em sums distintos: cada badge usa a MESMA cor do status na
  // row (open=neutro, partial=warning, overdue=error, paid=success). Misturar
  // open+partial num badge amarelo dava cor enganadora (open não é warning).
  const monthGroups = [...monthBuckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, items]) => {
      let openSum = 0;
      let partialSum = 0;
      let overdueSum = 0;
      let paidSum = 0;
      for (const c of items) {
        const sign = c.nature === "credit" ? -1 : 1;
        const open = Number(c.openAmount ?? 0) * sign;
        const original = Number(c.originalAmount ?? 0) * sign;
        const status = String(c.status ?? "");
        if (status === "overdue") overdueSum += open;
        else if (status === "partial") partialSum += open;
        else if (status === "open") openSum += open;
        else if (status === "paid") paidSum += original;
      }
      return {
        month,
        label: formatMonthLabel(month),
        items,
        count: items.length,
        openSum,
        partialSum,
        overdueSum,
        paidSum,
      };
    });

  let title: string;
  let section: string;
  if (kind === "payable") {
    title = "Despesas / A Pagar";
    section = "charges_payable";
  } else if (nature === "credit") {
    title = "Créditos a Condóminos";
    section = "charges_credits";
  } else {
    title = "Quotas / A Receber";
    section = "charges_receivable";
  }
  const today = new Date().toISOString().slice(0, 10);

  // availableYears da API + ano atual garantido (mesmo sem charges nesse ano).
  const availableYearsSet = new Set<number>(chargesRes.meta.availableYears);
  availableYearsSet.add(currentYear);
  const availableYears = [...availableYearsSet].sort((a, b) => b - a);

  // Querystrings prev/next pré-computadas, preservando filtros ativos.
  const pagination = chargesRes.pagination
    ? buildPaginationMeta(chargesRes.pagination, params, [
      "kind",
      "nature",
      "year",
      "status",
      "chargeType",
      "perPage",
    ])
    : null;

  return {
    title,
    section,
    charges: sortedCharges,
    monthGroups,
    kind,
    nature,
    scope,
    filterYear,
    filterStatus: statusFilter,
    filterSearch: searchFilter,
    filterChargeType: typeFilter,
    availableYears,
    outOfYear: chargesRes.meta.outOfYear,
    suppliers: suppliers.data,
    accounts: accounts.data,
    today,
    pagination,
    flash,
  };
}

/** GET /charges - página completa (1ª visita ou full reload). */
export async function listCharges(
  params: Record<string, string>,
  flash: { type: string; message: string } | null = null,
) {
  const data = await fetchChargesData(params, flash);
  return await render("pages/charges/list.vto", data);
}

/** GET /charges (HX-Request: true) - só o fragmento dinâmico (KPIs +
 *  banner + filtros + tabela + modal). Resposta HTML sem layout admin. */
export async function listChargesFragment(
  params: Record<string, string>,
) {
  const data = await fetchChargesData(params, null);
  return await render("pages/charges/_list_fragment.vto", data);
}

/** GET /charges/:id */
export async function showCharge(
  id: string,
  flash: { type: string; message: string } | null = null,
) {
  // listUnits só para o modal de Refaturação (lista completa de frações).
  // Labels do header vêm do nested da charge; refaturações filtradas por sourceId.
  const [
    chargeResult,
    refactsResult,
    unitsResult,
    ledgerResult,
    attachmentsResult,
    settlementsResult,
  ] = await Promise
    .all([
      client.admin.getCharge(id),
      client.admin.listCharges({ sourceId: id }),
      client.admin.listUnits(),
      client.admin.getChargeLedger(id).catch(() => ({
        data: [] as Array<Record<string, unknown>>,
      })),
      client.admin.listChargeAttachments(id).catch(() => ({
        data: [] as Array<Record<string, unknown>>,
      })),
      client.admin.listSettlements({ chargeId: id }),
    ]);

  const charge = chargeResult.data;
  const refactsList = refactsResult.data;
  const units = unitsResult.data;

  // Server-side já trouxe só filhos (sourceId=id); o filter por chargeType
  // fica por segurança (outros tipos com mesmo sourceId no futuro).
  const refacturations = refactsList
    .filter((c) => c.chargeType === "refacturation")
    .map((c) => ({
      ...c,
      // Formato canónico "designação - identificador" ($shared/labels), o mesmo
      // do cabeçalho da charge - a designação sozinha não chega para distinguir.
      unit_label: c.unit ? labelForUnit(c.unit) : null,
    }));
  const refacturedTotal = refacturations.reduce(
    (s, c) => s + c.originalAmount,
    0,
  );

  // Se é refaturação, resolve a charge original por ID direto (não a lista inteira).
  let sourceCharge: Charge | null = null;
  if (charge.sourceType === "refacturation" && typeof charge.sourceId === "string") {
    try {
      const sourceResult = await client.admin.getCharge(charge.sourceId);
      sourceCharge = sourceResult.data;
    } catch {
      sourceCharge = null; // source foi apagada - fallback gracioso
    }
  }

  // Etiqueta despesa -> orçamento (relatório por Ata). Só payables: as quotas
  // já apontam ao seu orçamento por sourceType/sourceId. Fetch condicional
  // para não pagar a lista em todas as charges.
  const budgets = charge.kind === "payable"
    ? (await client.admin.listBudgets().catch(() => ({ data: [] }))).data
      .filter((b) => b.status === "approved")
      .map((b) => ({
        id: b.id,
        label: `${b.year} ${b.type === "suplementar" ? "suplementar (obra)" : "principal"}`,
      }))
    : [];

  // Labels do header, diretos do nested da charge.
  const supplierLabel = charge.supplier ? labelForSupplier(charge.supplier) : null;
  const unitLabel = charge.unit ? labelForUnit(charge.unit) : null;
  const accountLabel = charge.account ? `${charge.account.code} - ${charge.account.name}` : null;

  // Refaturar permitido em qualquer payable ativa; bloqueado em cancelled
  // (source nulo) e em refaturações. Permite redistribuir custo a posteriori
  // (ex: infiltração já paga que se descobre ser responsabilidade da fração A).
  const canRefacture = charge.kind === "payable" &&
    charge.chargeType !== "refacturation" &&
    charge.status !== "cancelled";
  const refacturable = Number(charge.originalAmount ?? 0) - refacturedTotal;

  // Cancelar desfaz os offsets (charge_offset) no mesmo ato; um pagamento
  // conciliado com o banco bloqueia. Mesmo guard da API (charge/cancel.ts).
  const activeSettlements = settlementsResult.data.filter((s) => s.status === "active");
  const canCancel = ["open", "partial", "paid", "overdue"].includes(charge.status) &&
    activeSettlements.every((s) => s.settlementType === "charge_offset");
  const offsetsToUndo = activeSettlements.map((s) => {
    const other = s.debitChargeId === id ? s.creditCharge : s.debitCharge;
    return {
      id: s.id,
      amount: s.amount,
      code: other?.code ?? null,
      description: other?.description ?? "",
      competencePeriod: other?.competencePeriod ?? null,
    };
  });

  // Ledger entries da charge (diretas + via settlements), createdAt asc.
  // Totais Dr/Cr para o user verificar dupla-partida de relance.
  const ledgerEntries = (ledgerResult.data ?? []) as Array<{
    id: string;
    entryDate: string;
    entryType: string;
    accountCode: string;
    direction: string;
    amount: number;
    description: string;
    refType: string | null;
    refId: string | null;
    createdAt: string;
  }>;
  const ledgerTotals = ledgerEntries.reduce(
    (acc, l) => {
      if (l.direction === "debit") acc.debitCents += Number(l.amount);
      else if (l.direction === "credit") acc.creditCents += Number(l.amount);
      return acc;
    },
    { debitCents: 0, creditCents: 0 },
  );

  const attachments = (attachmentsResult.data ?? []) as Array<Record<string, unknown>>;

  // FCR: fn_charge_ai emite Cr 723 (Contribuições FCR) por quota. Lido do
  // ledger - única fonte de verdade (não duplica state na charge).
  const fcrAmountCents = ledgerEntries
    .filter((l) =>
      l.entryType === "charge_created" &&
      l.accountCode === "723" &&
      l.direction === "credit"
    )
    .reduce((s, l) => s + Number(l.amount), 0);

  return await render("pages/charges/show.vto", {
    title: `Cobrança ${charge.id}`,
    section: charge.kind === "payable" ? "charges_payable" : "charges_receivable",
    charge,
    sourceCharge,
    refacturations,
    refacturedTotal,
    refacturable,
    canRefacture,
    canCancel,
    offsetsToUndo,
    units,
    supplierLabel,
    unitLabel,
    accountLabel,
    ledgerEntries,
    ledgerTotals,
    fcrAmountCents,
    attachments,
    budgets,
    // Default do vencimento da refaturação: último dia do mês seguinte.
    refacturationDueDate: lastDayOfNextMonth(new Date().toISOString().slice(0, 10)),
    flash,
  });
}

/** POST charges/:id/budget - etiqueta a despesa com o orçamento aprovado numa
 *  Ata. "" = limpar a etiqueta (volta a inferir pela rubrica + ano). */
export async function setChargeBudget(chargeId: string, form: Record<string, string | File>) {
  const budgetId = parseFormString(form, "budgetId");
  await client.admin.setChargeBudget(chargeId, budgetId === "" ? null : budgetId);
}

// ─── Charge attachments (faturas, recibos, comprovativos) ──────────────────

export async function uploadChargeAttachment(
  chargeId: string,
  file: File,
): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await client.admin.addChargeAttachment(
    chargeId,
    bytes,
    file.name || "fatura",
    file.type || "application/octet-stream",
  );
}

export async function deleteChargeAttachment(
  chargeId: string,
  attachmentId: string,
): Promise<void> {
  await client.admin.deleteChargeAttachment(chargeId, attachmentId);
}

// GET .../charges/:id/attachments/:attachmentId - proxy aos bytes do anexo:
// `<a href>` não manda o Bearer JWT, então o panel injecta auth via cookie e
// faz forward do content-type/disposition.
export async function downloadChargeAttachment(
  chargeId: string,
  attachmentId: string,
): Promise<Response> {
  const upstream = await client.admin.downloadStream(
    `/charges/${chargeId}/attachments/${attachmentId}`,
  );
  return proxyDownload(upstream, {
    errorPrefix: "Erro ao obter anexo",
    cacheControl: "private, max-age=3600",
  });
}

export async function createCharge(form: Record<string, string | File>) {
  // chargeType/competencePeriod opcionais: a API infere defaults
  // (ver api/modules/admin/charge/defaults.ts). Só passamos se o form enviou.
  const explicitChargeType = parseFormString(form, "chargeType");
  const explicitCompetence = parseFormString(form, "competencePeriod");

  const paymentMethod = parseFormString(form, "paymentMethod");

  const result = await client.admin.createCharge({
    kind: parseFormString(form, "kind", { default: "payable" }),
    ...(explicitChargeType ? { chargeType: explicitChargeType } : {}),
    description: parseFormString(form, "description"),
    issueDate: parseFormString(form, "issueDate"),
    dueDate: parseFormString(form, "dueDate", { emptyAsNull: true }),
    ...(explicitCompetence ? { competencePeriod: explicitCompetence } : {}),
    amountCents: parseEurosToCents(form.amount) ?? 0,
    supplierId: parseFormString(form, "supplierId", { emptyAsNull: true }),
    accountId: parseFormString(form, "accountId", { emptyAsNull: true }),
    invoiceNumber: parseFormString(form, "invoiceNumber", { emptyAsNull: true }),
    documentNumber: parseFormString(form, "documentNumber", { emptyAsNull: true }),
    ...(paymentMethod ? { paymentMethod } : {}),
    note: parseFormString(form, "note", { emptyAsNull: true }),
  });
  return result.data;
}

export async function updateCharge(chargeId: string, form: Record<string, string | File>) {
  // null (input vazio) = "não tocar no amount".
  const amountCentsMaybe = parseEurosToCents(form.amount);
  // competencePeriod: normaliza YYYY-MM → YYYY-MM-01. Vazio → OMITIDO do body
  // (handler preserva); enviar null apagaria a competência ao editar.
  const competenceRaw = parseFormString(form, "competencePeriod");
  let competencePeriod: string | undefined;
  if (/^\d{4}-\d{2}-01$/.test(competenceRaw)) competencePeriod = competenceRaw;
  else if (/^\d{4}-\d{2}$/.test(competenceRaw)) competencePeriod = `${competenceRaw}-01`;

  const paymentMethod = parseFormString(form, "paymentMethod");

  const body: Record<string, unknown> = {
    description: parseFormString(form, "description") || undefined,
    issueDate: parseFormString(form, "issueDate") || undefined,
    dueDate: parseFormString(form, "dueDate", { emptyAsNull: true }),
    invoiceNumber: parseFormString(form, "invoiceNumber", { emptyAsNull: true }),
    documentNumber: parseFormString(form, "documentNumber", { emptyAsNull: true }),
    // Nota interna: trim → string vazia vira `null` para limpar a coluna
    // (e não persistir "" como valor).
    note: parseFormString(form, "note", { emptyAsNull: true }),
  };
  if (competencePeriod) body.competencePeriod = competencePeriod;
  if (amountCentsMaybe !== null) body.amountCents = amountCentsMaybe;
  if (paymentMethod) body.paymentMethod = paymentMethod;
  const result = await client.admin.updateCharge(chargeId, body);
  return result.data;
}

/** Cancela uma charge com justificação. A API desfaz os offsets e os
 *  triggers anulam o lançamento; guards (estado/settlements) vivem na API. */
export async function cancelCharge(chargeId: string, form: Record<string, string | File>) {
  const result = await client.admin.cancelCharge(chargeId, {
    reason: parseFormString(form, "reason"),
  });
  return result.data;
}

export async function createRefacturations(chargeId: string, form: Record<string, string | File>) {
  // Form: alloc_<idx>_unit_id + alloc_<idx>_amount, índices arbitrários, só valor > 0.
  // Índice pode ser vazio (Vento renderiza `0` como ""); regex aceita ambos.
  const allocs: Array<{ unitId: string; amountCents: number }> = [];
  for (const [key, value] of Object.entries(form)) {
    const m = key.match(/^alloc_(\w*)_unit_id$/);
    if (!m) continue;
    const idx = m[1];
    const unitId = String(value ?? "").trim();
    const amountCents = parseEurosToCents(form[`alloc_${idx}_amount`]);
    if (!unitId || amountCents === null || amountCents <= 0) continue;
    allocs.push({ unitId, amountCents });
  }
  if (allocs.length === 0) throw new Error("Nenhuma fração com valor");
  const dueDate = parseFormString(form, "dueDate");
  if (!dueDate) throw new Error("Data de vencimento obrigatória");
  const result = await client.admin.createRefacturations(chargeId, {
    allocations: allocs,
    issueDate: parseFormString(form, "issueDate") || undefined,
    dueDate,
  });
  return result.data;
}

export async function generateQuotas(budgetId: string, form: Record<string, string | File> = {}) {
  const throughDate = parseFormString(form, "throughDate") || undefined;
  // Suplementar: mês da 1ª prestação (principal ignora-o e usa throughDate).
  const firstMonth = parseFormString(form, "firstMonth") || undefined;
  const { data } = await client.admin.generateQuotas(budgetId, { throughDate, firstMonth });
  const d = data as { chargesCreated?: number; crossesYear?: boolean };
  return { ok: true, chargesCreated: d.chargesCreated ?? 0, crossesYear: d.crossesYear ?? false };
}
